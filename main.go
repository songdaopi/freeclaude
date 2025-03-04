package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// GrokClient defines a client for interacting with the Grok 3 Web API.
// It encapsulates the API endpoints, HTTP headers, and configuration flags.
type GrokClient struct {
	newUrl         string            // Endpoint for creating new conversations
	headers        map[string]string // HTTP headers for API requests
	isReasoning    bool              // Flag for using reasoning model
	keepChat       bool              // Flag to preserve chat history
	ignoreThinking bool              // Flag to exclude thinking tokens in responses
}

// NewGrokClient creates a new instance of GrokClient with the provided cookies and configuration flags.
func NewGrokClient(cookies string, isReasoning bool, keepChat bool, ignoreThinking bool) *GrokClient {
	return &GrokClient{
		newUrl: "https://grok.com/rest/app-chat/conversations/new",
		headers: map[string]string{
			"accept":             "*/*",
			"accept-language":    "en-GB,en;q=0.9",
			"content-type":       "application/json",
			"origin":             "https://grok.com",
			"priority":           "u=1, i",
			"referer":            "https://grok.com/",
			"sec-ch-ua":          `"Not/A)Brand";v="8", "Chromium";v="126", "Brave";v="126"`,
			"sec-ch-ua-mobile":   "?0",
			"sec-ch-ua-platform": `"macOS"`,
			"sec-fetch-dest":     "empty",
			"sec-fetch-mode":     "cors",
			"sec-fetch-site":     "same-origin",
			"sec-gpc":            "1",
			"user-agent":         "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
			"cookie":             cookies,
		},
		isReasoning:    isReasoning,
		keepChat:       keepChat,
		ignoreThinking: ignoreThinking,
	}
}

// preparePayload constructs the request payload for the Grok 3 Web API based on the given message and reasoning flag.
func (c *GrokClient) preparePayload(message string, isReasoning bool) map[string]any {
	return map[string]any{
		"customInstructions":        "",
		"deepsearchPreset":          "",
		"disableSearch":             false,
		"enableImageGeneration":     true,
		"enableImageStreaming":      true,
		"enableSideBySide":          true,
		"fileAttachments":           []string{},
		"forceConcise":              false,
		"imageAttachments":          []string{},
		"imageGenerationCount":      2,
		"isPreset":                  false,
		"isReasoning":               isReasoning,
		"message":                   message,
		"modelName":                 "grok-3",
		"returnImageBytes":          false,
		"returnRawGrokInXaiRequest": false,
		"sendFinalMetadata":         true,
		"temporary":                 !c.keepChat,
		"toolOverrides":             map[string]any{},
	}
}

// getModelName returns the appropriate model name based on the isReasoning flag.
func (c *GrokClient) getModelName() string {
	if c.isReasoning {
		return grok3ReasoningModelName
	} else {
		return grok3ModelName
	}
}

// RequestBody represents the structure of the JSON body expected in POST requests to the /v1/chat/completions endpoint,
// following the OpenAI API format. It includes fields for model selection, messages, streaming option, and additional specific options.
type RequestBody struct {
	Model    string `json:"model"`
	Messages []struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	} `json:"messages"`
	Stream           bool   `json:"stream"`
	GrokCookies      any    `json:"grokCookies,omitempty"` // A single cookie(string), or a list of cookie([]string)
	CookieIndex      uint   `json:"cookieIndex,omitempty"` // Start from 1, 0 means auto-select cookies in turn
	TextBeforePrompt string `json:"textBeforePrompt,omitempty"`
	TextAfterPrompt  string `json:"textAfterPrompt,omitempty"`
	KeepChat         int    `json:"keepChat,omitempty"`       // > 0 is true, == 0 is false
	IgnoreThinking   int    `json:"ignoreThinking,omitempty"` // > 0 is true, == 0 is false
}

// ResponseToken represents a single token response from the Grok 3 Web API.
type ResponseToken struct {
	Result struct {
		Response struct {
			Token      string `json:"token"`
			IsThinking bool   `json:"isThinking"`
		} `json:"response"`
	} `json:"result"`
}

// ModelData represents model metadata for OpenAI-compatible response.
type ModelData struct {
	Id       string `json:"id"`
	Object   string `json:"object"`
	Owned_by string `json:"owned_by"`
}

// ModelList contains available models for OpenAI-compatible endpoint.
type ModelList struct {
	Object string      `json:"object"`
	Data   []ModelData `json:"data"`
}

const (
	grok3ModelName          = "grok-3"
	grok3ReasoningModelName = "grok-3-reasoning"

	completionsPath = "/v1/chat/completions"
	listModelsPath  = "/v1/models"
)

// Global configuration variables set.
var (
	apiToken         *string
	grokCookies      []string
	textBeforePrompt *string
	textAfterPrompt  *string
	keepChat         *bool
	ignoreThinking   *bool
	httpProxy        *string
	httpClient       = &http.Client{Timeout: 30 * time.Minute}
	nextCookieIndex  = struct { // Thread-safe cookie rotation
		sync.Mutex
		index uint // Start from 0
	}{}
)

// sendMessage sends a message to the Grok 3 Web API and returns the response body as an io.ReadCloser.
// If stream is true, it returns the streaming response; otherwise, it reads the entire response.
func (c *GrokClient) sendMessage(message string, stream bool) (io.ReadCloser, error) {
	payload := c.preparePayload(message, c.isReasoning)
	jsonPayload, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal payload: %v", err)
	}

	req, err := http.NewRequest(http.MethodPost, c.newUrl, bytes.NewBuffer(jsonPayload))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %v", err)
	}

	for key, value := range c.headers {
		req.Header.Set(key, value)
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, fmt.Errorf("the Grok API error: %d %s", resp.StatusCode, resp.Status)
		}
		return nil, fmt.Errorf("the Grok API error: %d %s, response body: %s", resp.StatusCode, resp.Status, string(body))
	}

	if stream {
		return resp.Body, nil
	} else {
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return nil, fmt.Errorf("failed to read response body: %v", err)
		}
		return io.NopCloser(bytes.NewReader(body)), nil
	}
}

type OpenAIChatCompletionMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type OpenAIChatCompletionChunkChoice struct {
	Index        int                         `json:"index"`
	Delta        OpenAIChatCompletionMessage `json:"delta"`
	FinishReason string                      `json:"finish_reason"`
}

// OpenAIChatCompletionChunk represents the streaming response format for OpenAI.
type OpenAIChatCompletionChunk struct {
	ID      string                            `json:"id"`
	Object  string                            `json:"object"`
	Created int64                             `json:"created"`
	Model   string                            `json:"model"`
	Choices []OpenAIChatCompletionChunkChoice `json:"choices"`
}

type OpenAIChatCompletionChoice struct {
	Index        int                         `json:"index"`
	Message      OpenAIChatCompletionMessage `json:"message"`
	FinishReason string                      `json:"finish_reason"`
}

type OpenAIChatCompletionUsage struct {
	PromptTokens     int `json:"prompt_tokens"`
	CompletionTokens int `json:"completion_tokens"`
	TotalTokens      int `json:"total_tokens"`
}

// OpenAIChatCompletion represents the non-streaming response format for OpenAI.
type OpenAIChatCompletion struct {
	ID      string                       `json:"id"`
	Object  string                       `json:"object"`
	Created int64                        `json:"created"`
	Model   string                       `json:"model"`
	Choices []OpenAIChatCompletionChoice `json:"choices"`
	Usage   OpenAIChatCompletionUsage    `json:"usage"`
}

// createOpenAIStreamingResponse returns an HTTP handler that converts the Grok 3 streaming response to OpenAI's streaming format
// and writes it to the response writer.
func (c *GrokClient) createOpenAIStreamingResponse(grokStream io.Reader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Set up headers for streaming response
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")

		flusher, ok := w.(http.Flusher)
		if !ok {
			log.Println("Streaming unsupported")
			http.Error(w, "Streaming unsupported", http.StatusInternalServerError)
			return
		}

		completionID := "chatcmpl-" + uuid.New().String()

		// Create and send the initial chunk
		startChunk := OpenAIChatCompletionChunk{
			ID:      completionID,
			Object:  "chat.completion.chunk",
			Created: time.Now().Unix(),
			Model:   c.getModelName(),
			Choices: []OpenAIChatCompletionChunkChoice{
				{
					Index: 0,
					Delta: OpenAIChatCompletionMessage{
						Role: "assistant",
					},
					FinishReason: "",
				},
			},
		}
		fmt.Fprintf(w, "data: %s\n\n", mustMarshal(startChunk))
		flusher.Flush()

		// Read and process the streaming response from Grok 3
		isThinking := false
		buffer := make([]byte, 1024)
		for {
			n, err := grokStream.Read(buffer)
			if err != nil {
				if err == io.EOF {
					break
				}
				log.Printf("Error reading stream: %v", err)
				return
			}

			chunk := string(buffer[:n])
			lines := strings.SplitSeq(chunk, "\n")
			for line := range lines {
				line = strings.TrimSpace(line)
				if line == "" {
					continue
				}

				var token ResponseToken
				if err := json.Unmarshal([]byte(line), &token); err != nil {
					continue
				}

				respToken := token.Result.Response.Token
				// Handle thinking tokens based on configuration
				if c.ignoreThinking && token.Result.Response.IsThinking {
					continue
				} else if token.Result.Response.IsThinking {
					if !isThinking {
						respToken = "<think>\n" + respToken
					}
					isThinking = true
				} else if isThinking {
					respToken = respToken + "\n</think>\n\n"
					isThinking = false
				}

				if respToken != "" {
					// Send token as a chunk in OpenAI format
					chunk := OpenAIChatCompletionChunk{
						ID:      completionID,
						Object:  "chat.completion.chunk",
						Created: time.Now().Unix(),
						Model:   c.getModelName(),
						Choices: []OpenAIChatCompletionChunkChoice{
							{
								Index: 0,
								Delta: OpenAIChatCompletionMessage{
									Content: respToken,
								},
								FinishReason: "",
							},
						},
					}
					fmt.Fprintf(w, "data: %s\n\n", mustMarshal(chunk))
					flusher.Flush()
				}
			}
		}

		// Send the final chunk after streaming ends
		finalChunk := OpenAIChatCompletionChunk{
			ID:      completionID,
			Object:  "chat.completion.chunk",
			Created: time.Now().Unix(),
			Model:   c.getModelName(),
			Choices: []OpenAIChatCompletionChunkChoice{
				{
					Index:        0,
					Delta:        OpenAIChatCompletionMessage{},
					FinishReason: "stop",
				},
			},
		}
		fmt.Fprintf(w, "data: %s\n\n", mustMarshal(finalChunk))
		flusher.Flush()

		// Finish the stream
		fmt.Fprintf(w, "data: [DONE]\n\n")
		flusher.Flush()

	}
}

// createOpenAIFullResponse returns an HTTP handler that reads the full Grok 3 response, converts it to OpenAI's format,
// and writes it to the response writer.
func (c *GrokClient) createOpenAIFullResponse(grokFull io.Reader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var fullResponse strings.Builder
		buf := new(strings.Builder)
		_, err := io.Copy(buf, grokFull)
		if err != nil {
			log.Printf("Reading response error: %v", err)
			http.Error(w, fmt.Sprintf("Reading response error: %v", err), http.StatusInternalServerError)
			return
		}

		isThinking := false
		lines := strings.SplitSeq(buf.String(), "\n")
		for line := range lines {
			line = strings.TrimSpace(line)
			if line == "" {
				continue
			}

			var token ResponseToken
			if err := json.Unmarshal([]byte(line), &token); err != nil {
				continue
			}

			respToken := token.Result.Response.Token
			if c.ignoreThinking && token.Result.Response.IsThinking {
				continue
			} else if token.Result.Response.IsThinking {
				if !isThinking {
					respToken = "<think>\n" + respToken
				}
				isThinking = true
			} else if isThinking {
				respToken = respToken + "\n</think>\n\n"
				isThinking = false
			}

			fullResponse.WriteString(respToken)
		}

		openAIResponse := c.createOpenAIFullResponseBody(fullResponse.String())
		w.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(w).Encode(openAIResponse); err != nil {
			log.Printf("Encoding response error: %v", err)
			http.Error(w, fmt.Sprintf("Encoding response error: %v", err), http.StatusInternalServerError)
			return
		}
	}
}

// createOpenAIFullResponseBody creates the OpenAI response body for non-streaming requests.
func (c *GrokClient) createOpenAIFullResponseBody(content string) OpenAIChatCompletion {
	return OpenAIChatCompletion{
		ID:      "chatcmpl-" + uuid.New().String(),
		Object:  "chat.completion",
		Created: time.Now().Unix(),
		Model:   c.getModelName(),
		Choices: []OpenAIChatCompletionChoice{
			{
				Index: 0,
				Message: OpenAIChatCompletionMessage{
					Role:    "assistant",
					Content: content,
				},
				FinishReason: "stop",
			},
		},
		Usage: OpenAIChatCompletionUsage{
			PromptTokens:     -1,
			CompletionTokens: -1,
			TotalTokens:      -1,
		},
	}
}

// mustMarshal serializes the given value to a JSON string, panicking on error.
func mustMarshal(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// getCookieIndex selects the next cookie index in a round-robin fashion for load balancing or rotation.
// If cookieIndex is 0 or out of range, it uses the next index in sequence (len must be > 0).
func getCookieIndex(len int, cookieIndex uint) uint {
	if cookieIndex == 0 || cookieIndex > uint(len) {
		nextCookieIndex.Lock()
		defer nextCookieIndex.Unlock()
		index := nextCookieIndex.index
		nextCookieIndex.index = (nextCookieIndex.index + 1) % uint(len)

		return index % uint(len)
	} else {
		return cookieIndex - 1
	}
}

// handleChatCompletion handles incoming POST requests to /v1/chat/completions, authenticates the request,
// parses the request body, interacts with the Grok 3 API, and sends the response in OpenAI's format.
func handleChatCompletion(w http.ResponseWriter, r *http.Request) {
	// Log the request details
	log.Printf("Request from %s for %s", r.RemoteAddr, completionsPath)

	if r.URL.Path != completionsPath {
		log.Printf("Requested Path %s Not Found", r.URL.Path)
		http.Error(w, "Requested Path Not Found", http.StatusNotFound)
		return
	}

	if r.Method != http.MethodPost {
		log.Printf("Method %s Not Allowed", r.Method)
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	// Authenticate the request
	authHeader := r.Header.Get("Authorization")
	if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
		log.Println("Unauthorized: Bearer token required")
		http.Error(w, "Unauthorized: Bearer token required", http.StatusUnauthorized)
		return
	}

	token := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	if token != *apiToken {
		log.Println("Unauthorized: Invalid token")
		http.Error(w, "Unauthorized: Invalid token", http.StatusUnauthorized)
		return
	}

	// Parse the request body
	body := RequestBody{KeepChat: -1, IgnoreThinking: -1}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		log.Println("Bad Request: Invalid JSON")
		http.Error(w, "Bad Request: Invalid JSON", http.StatusBadRequest)
		return
	}

	// Select the appropriate cookie
	var cookie string
	var cookieIndex uint
	if body.GrokCookies != nil {
		if ck, ok := body.GrokCookies.(string); ok {
			cookie = ck
		} else if list, ok := body.GrokCookies.([]any); ok {
			if len(list) > 0 {
				cookieIndex = getCookieIndex(len(list), body.CookieIndex)
				if ck, ok := list[cookieIndex].(string); ok {
					cookie = ck
				}
			}
		}
	}
	cookie = strings.TrimSpace(cookie)
	if cookie == "" && len(grokCookies) > 0 {
		cookieIndex = getCookieIndex(len(grokCookies), body.CookieIndex)
		cookie = grokCookies[cookieIndex]
	}
	cookie = strings.TrimSpace(cookie)
	if cookie == "" {
		log.Println("Error: No Grok 3 cookie")
		http.Error(w, "Error: No Grok 3 cookie", http.StatusBadRequest)
		return
	}

	messages := body.Messages
	if len(messages) == 0 {
		log.Println("Bad Request: No messages provided")
		http.Error(w, "Bad Request: No messages provided", http.StatusBadRequest)
		return
	}

	// Construct the message to send to Grok 3
	messageJson := bytes.NewBuffer([]byte{})
	jsonEncoder := json.NewEncoder(messageJson)
	jsonEncoder.SetEscapeHTML(false) // Don't escape &, <, and >
	jsonEncoder.SetIndent("", "")
	err := jsonEncoder.Encode(messages)
	if err != nil {
		log.Println("Error: Encoding JSON failed")
		http.Error(w, "Error: Encoding JSON failed", http.StatusInternalServerError)
		return
	}
	if messageJson.Len() <= 2 {
		log.Println("Bad Request: No user message found")
		http.Error(w, "Bad Request: No user message found", http.StatusBadRequest)
		return
	}

	var beforePromptText string
	var afterPromptText string
	if body.TextBeforePrompt != "" {
		beforePromptText = body.TextBeforePrompt
	} else {
		beforePromptText = *textBeforePrompt
	}
	if body.TextAfterPrompt != "" {
		afterPromptText = body.TextAfterPrompt
	} else {
		afterPromptText = *textAfterPrompt
	}
	message := beforePromptText + messageJson.String() + afterPromptText

	// Determine configuration flags
	isReasoning := false
	if strings.TrimSpace(body.Model) == grok3ReasoningModelName {
		isReasoning = true
	}

	keepConversation := false
	if body.KeepChat > 0 {
		keepConversation = true
	} else if body.KeepChat < 0 {
		keepConversation = *keepChat
	}

	ignoreThink := false
	if body.IgnoreThinking > 0 {
		ignoreThink = true
	} else if body.IgnoreThinking < 0 {
		ignoreThink = *ignoreThinking
	}

	// Initialize GrokClient with selected options
	grokClient := NewGrokClient(cookie, isReasoning, keepConversation, ignoreThink)
	log.Printf("Use the cookie with index %d to request Grok 3 Web API", cookieIndex+1)
	// Send the message to Grok 3 Web API
	respReader, err := grokClient.sendMessage(message, body.Stream)
	if err != nil {
		log.Printf("Error: %v", err)
		http.Error(w, fmt.Sprintf("Error: %v", err), http.StatusInternalServerError)
		return
	}
	defer respReader.Close()

	// Handle the response based on streaming option
	if body.Stream {
		grokClient.createOpenAIStreamingResponse(respReader)(w, r)
	} else {
		grokClient.createOpenAIFullResponse(respReader)(w, r)
	}
}

// listModels handles GET requests to /v1/models, returning a list of available models in OpenAI's format.
func listModels(w http.ResponseWriter, r *http.Request) {
	// Log the request details
	log.Printf("Request from %s for %s", r.RemoteAddr, listModelsPath)

	if r.URL.Path != listModelsPath {
		log.Printf("Requested Path %s Not Found", r.URL.Path)
		http.Error(w, "Requested Path Not Found", http.StatusNotFound)
		return
	}

	if r.Method != http.MethodGet {
		log.Printf("Method %s Not Allowed", r.Method)
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return
	}

	list := ModelList{
		Object: "list",
		Data: []ModelData{
			{
				Id:       grok3ModelName,
				Object:   "model",
				Owned_by: "xAI",
			},
			{
				Id:       grok3ReasoningModelName,
				Object:   "model",
				Owned_by: "xAI",
			},
		},
	}

	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(list); err != nil {
		log.Printf("Encoding response error: %v", err)
		http.Error(w, fmt.Sprintf("Encoding response error: %v", err), http.StatusInternalServerError)
		return
	}
}

// main parses command-line flags, sets up the HTTP server, and starts listening for requests.
func main() {
	// Define command-line flags
	apiToken = flag.String("token", "", "Authentication token (GROK3_AUTH_TOKEN)")
	cookie := flag.String("cookie", "", "Grok cookie (GROK3_COOKIE)")
	textBeforePrompt = flag.String("textBeforePrompt", "For the data below, entries with the role 'system' are system information, entries with the role 'assistant' are messages you have previously sent, entries with the role 'user' are messages sent by the user. You need to respond to the user's last message accordingly based on the corresponding data.", "Text before the prompt")
	textAfterPrompt = flag.String("textAfterPrompt", "", "Text after the prompt")
	keepChat = flag.Bool("keepChat", false, "Don't delete the chat conversation after request")
	ignoreThinking = flag.Bool("ignoreThinking", false, "Ignore the thinking content while using the reasoning model")
	httpProxy = flag.String("httpProxy", "", "HTTP/SOCKS5 proxy")
	port := flag.Uint("port", 8180, "Server port")
	flag.Parse()

	// Validate port number
	if *port > 65535 {
		log.Fatalf("Server port %d is greater than 65535", *port)
	}

	// Set authentication token from flag or environment variable
	*apiToken = strings.TrimSpace(*apiToken)
	if *apiToken == "" {
		*apiToken = os.Getenv("GROK3_AUTH_TOKEN")
		if *apiToken == "" {
			log.Fatal("Authentication token (GROK3_AUTH_TOKEN) is unset")
		}
	}

	// Set cookies from flag or environment variable
	*cookie = strings.TrimSpace(*cookie)
	if *cookie == "" {
		*cookie = strings.TrimSpace(os.Getenv("GROK3_COOKIE"))
	}
	if *cookie != "" {
		err := json.Unmarshal([]byte(*cookie), &grokCookies)
		if err != nil {
			grokCookies = []string{*cookie}
		}
	}

	// Configure HTTP client with proxy if provided
	*httpProxy = strings.TrimSpace(*httpProxy)
	if *httpProxy != "" {
		proxyURL, err := url.Parse(*httpProxy)
		if err == nil {
			httpClient.Transport = &http.Transport{
				Proxy: http.ProxyURL(proxyURL),
				DialContext: (&net.Dialer{
					Timeout:   30 * time.Second,
					KeepAlive: 30 * time.Second,
				}).DialContext,
				ForceAttemptHTTP2:   true,
				MaxIdleConns:        10,
				IdleConnTimeout:     600 * time.Second,
				TLSHandshakeTimeout: 20 * time.Second,
			}
		} else {
			log.Fatalf("Parsing HTTP/SOCKS5 proxy error：%v", err)
		}
	}

	// Register HTTP handlers
	http.HandleFunc(completionsPath, handleChatCompletion)
	http.HandleFunc(listModelsPath, listModels)
	log.Printf("Server starting on :%d", *port)

	// Start the HTTP server
	log.Fatal(http.ListenAndServe(fmt.Sprintf(":%d", *port), nil))
}
