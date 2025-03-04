# Grok 3 Web API Wrapper

**Chinese**:**本仓库为原作的docker化版本。**

鸣谢：[orzogc](https://github.com/orzogc)

This is a Go-based tool designed to interact with the Grok 3 Web API, offering an OpenAI-compatible endpoint for chat completions. It enables users to send messages to the Grok 3 Web API and receive responses in a format consistent with OpenAI's chat completion API.

## Docker

## Features

- **OpenAI-Compatible Endpoint**: Supports `/v1/chat/completions` and `/v1/models` endpoints.
- **Streaming Support**: Enables real-time streaming of responses.
- **Model Selection**: Choose between standard and reasoning models.
- **Cookie Management**: Manages multiple cookies.
- **Proxy Support**: Compatible with HTTP and SOCKS5 proxies for network requests.
- **Configurable Options**: Includes flags for retaining chat conversations, filtering thinking content, and adding custom text to prompts.

## Prerequisites

Before you use this tool, ensure you have the following:

- **Grok Cookie**: Obtain your account's cookie from [grok.com](https://grok.com) by your browser.
- **Authentication Token**: Prepare a token to secure the API endpoint.

## Configuration

You can configure the client using command-line flags or environment variables.

### Command-Line Flags

- `-token`: API authentication token (**required**).
- `-cookie`: Grok cookie(s) for authentication. Accepts a single cookie or a JSON array of cookies.
- `-textBeforePrompt`: Text to add before the user’s message. The default text can be viewed by using the `-help` flag.
- `-textAfterPrompt`: Text to add after the user’s message (default: empty string).
- `-keepChat`: Retains chat conversations after each request if set.
- `-ignoreThinking`: Excludes thinking tokens from responses when using the reasoning model.
- `-httpProxy`: Specifies an HTTP or SOCKS5 proxy URL. The proxy URL should be something like `http://127.0.0.1:1080` or `socks5://127.0.0.1:1080`.
- `-port`: Sets the server port (default: 8180).
- `-help`: Prints the help message.

Basic usage:

The API authentication token is **required** while running this tool. The Grok cookie must be set by the `-cookie` flag or the request body.

```
grok3_api -token your_secret_token
```

### Environment Variables

`GROK3_AUTH_TOKEN`: Alternative to the `-token` flag.

`GROK3_COOKIE`: Alternative to the `-cookie` flag.

`http_proxy`: Alternative to the `-httpProxy` flag.

### Request Body for Completion

Some configurations can be set in the request body while using the `/v1/chat/completions` endpoint.

Request body (JSON):

```json
{
  "messages": [],
  "model": "grok-3", // "grok-3" for the standard Grok 3 model, "grok-3-reasoning" for the Grok 3 reasoning model.
  "stream": true, // true for streaming response.
  "grokCookies": ["cookie1", "cookie2"], // a string for a single cookie, or a list of strings for multiple cookies.
  "cookieIndex": 1, // the index of cookie (starting from 1) to request Grok 3 Web API. If the index is 0, auto selecting cookies in turn (defalut behaviour).
  "textBeforePrompt": "System: You are a helpful assistant.", // text to add before the user’s message. The default text can be viewed by using the `-help` flag.
  "textAfterPrompt": "End of message.", // text to add after the user’s message (default: empty string).
  "keepChat": 1, // 1 to retain this chat conversation, 0 to not retain it (defalut behaviour).
  "ignoreThinking": 1 // 1 to exclude thinking tokens from the response when using the reasoning model, 0 to retain thinking tokens (defalut behaviour).
}
```

## Warnings

This tool offers an unofficial OpenAI-compatible API of Grok 3, so your account may be **banned** by xAI if using this tool.

Please do not abuse or use this tool for commercial purposes. Use it at your own risk.

## Special Thanks

- [mem0ai/grok3-api: Unofficial Grok 3 API](https://github.com/mem0ai/grok3-api)
- [RoCry/grok3-api-cf: Grok 3 via API with Cloudflare for free](https://github.com/RoCry/grok3-api-cf/tree/master)
- Most code was written by Grok 3, so thanks to Grok 3.
