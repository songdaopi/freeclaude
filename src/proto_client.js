import protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 字节数组混淆函数
function obfuscateBytes(byteArray) {
    let t = 165;
    for (let r = 0; r < byteArray.length; r++) {
        byteArray[r] = (byteArray[r] ^ t) + (r % 256);
        t = byteArray[r];
    }
    return byteArray;
}

// 根据token生成固定的machineId
function generateMachineIdFromToken(token) {
    const hash = createHash("sha256");
    hash.update(token);
    return hash.digest("hex");
}

// 生成checksum
function generateChecksum(token) {
    const timestamp = Math.floor(Date.now() / 1e6);
    const byteArray = new Uint8Array([
        (timestamp >> 40) & 255,
        (timestamp >> 32) & 255,
        (timestamp >> 24) & 255,
        (timestamp >> 16) & 255,
        (timestamp >> 8) & 255,
        255 & timestamp,
    ]);

    const obfuscatedBytes = obfuscateBytes(byteArray);
    const encodedChecksum = Buffer.from(obfuscatedBytes).toString('base64');
    
    const machineId = generateMachineIdFromToken(token);
    const macMachineId = generateMachineIdFromToken(token + '_mac');

    return `${encodedChecksum}${machineId}/${macMachineId}`;
}

// 构建请求体的函数
async function buildRequestBody(messages, modelName = 'claude-3.5-sonnet') {
    const protoPath = path.join(__dirname, '../proto/aiserver.proto');
    const root = await protobuf.load(protoPath);
    
    const GetChatRequest = root.lookupType('aiserver.v1.GetChatRequest');
    const ModelDetails = root.lookupType('aiserver.v1.ModelDetails');
    const ConversationMessage = root.lookupType('aiserver.v1.ConversationMessage');
    const ImageProto = root.lookupType('aiserver.v1.ImageProto');
    const Dimension = root.lookupType('aiserver.v1.ImageProto.Dimension');
    const ExplicitContext = root.lookupType('aiserver.v1.ExplicitContext');

    // 转换消息格式
    const protoMessages = messages.map(msg => {
        let formattedContent = '';
        let images = [];
        let containsImage = false;

        if (typeof msg.content === 'string') {
            formattedContent = msg.content;
        } else if (Array.isArray(msg.content)) {
            const textParts = [];
            msg.content.forEach(part => {
                if (typeof part === 'string') {
                    textParts.push(part);
                } else if (part.type === 'text') {
                    textParts.push(part.text);
                } else if (part.type === 'image_url') {
                    // 处理base64格式的图片URL
                    const base64Data = part.image_url.url.split(',')[1];
                    const imageData = Buffer.from(base64Data, 'base64');
                    
                    // 创建ImageProto对象
                    const imageProto = ImageProto.create({
                        data: imageData,
                        dimension: Dimension.create({
                            width: 0,
                            height: 0
                        })
                    });
                    images.push(imageProto);
                    containsImage = true;
                }
            });
            formattedContent = textParts.join(', ');
        }

        // 如果有图片，固定模型为claude-3.5-sonnet
        if (containsImage) {
            modelName = 'claude-3.5-sonnet';
        }

        return ConversationMessage.create({
            text: formattedContent,
            type: msg.role === 'user' 
                ? ConversationMessage.MessageType.MESSAGE_TYPE_HUMAN 
                : ConversationMessage.MessageType.MESSAGE_TYPE_AI,
            images: images,
            bubbleId: uuidv4()
        });
    });

    // 创建Model对象
    const model = ModelDetails.create({
        modelName: modelName,
    });

    // 创建Request对象
    const payload = {
        conversation: protoMessages,
        explicitContext: ExplicitContext.create({ context: '1' }),
        workspaceRootPath: '',
        modelDetails: model,
        requestId: uuidv4(),
        allowLongFileScan: false,
        isBash: false,
        conversationId: uuidv4(),
        canHandleFilenamesAfterLanguageIds: true,
        longContextMode: false,
        isEval: false,
        runnableCodeBlocks: false,
        shouldCache: false,
    };

    const message = GetChatRequest.create(payload);
    const buffer = GetChatRequest.encode(message).finish();

    const length = buffer.length;
    const lengthBuffer = Buffer.alloc(5);
    lengthBuffer.writeUIntBE(length, 0, 5);

    return Buffer.concat([lengthBuffer, buffer]);
}

// 处理流式响应的函数
async function* processStreamResponse(response) {
    const reader = response.body;
    let buffer = Buffer.alloc(0);
    const delimiterPattern = Buffer.from('00000000', 'hex');
    const delimiterLength = delimiterPattern.length;

    for await (const chunk of reader) {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)]);

        let delimiterIndex;
        while ((delimiterIndex = buffer.indexOf(delimiterPattern)) !== -1) {
            if (buffer.length < delimiterIndex + delimiterLength + 3) break;

            const byte1 = buffer[delimiterIndex + delimiterLength];
            const byte2 = buffer[delimiterIndex + delimiterLength + 1];
            const byte3 = buffer[delimiterIndex + delimiterLength + 2];

            if (byte2 !== 0x0A || (byte1 - 2) !== byte3) {
                buffer = buffer.slice(delimiterIndex + 1);
                continue;
            }

            const length = byte3;
            const chunkStart = delimiterIndex + delimiterLength + 3;
            const chunkEnd = chunkStart + length;

            if (buffer.length < chunkEnd) break;

            const chunkData = buffer.slice(chunkStart, chunkEnd);
            if (chunkData.length > 0) {
                const text = chunkData.toString('utf-8');
                yield {
                    choices: [{
                        delta: { content: text },
                        index: 0
                    }]
                };
            }

            buffer = buffer.slice(chunkEnd);
        }
    }
}

// 发送请求到Cursor API
async function sendRequest(token, messages, model = 'claude-3.5-sonnet') {
    const requestBody = await buildRequestBody(messages, model);

    const response = await fetch('https://api2.cursor.sh/aiserver.v1.AiService/StreamChat', {
        method: 'POST',
        headers: {
            'User-Agent': 'connect-es/1.6.1',
            'authorization': 'Bearer ' + token,
            'connect-accept-encoding': 'gzip,br',
            'connect-protocol-version': '1',
            'content-type': 'application/grpc-web+proto',
            'x-amzn-trace-id': uuidv4(),
            'x-client-key': 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2',
            'x-cursor-checksum': generateChecksum(token),
            'x-cursor-client-version': '0.42.4',
            'x-cursor-timezone': 'Asia/Shanghai',
            'x-ghost-mode': 'true',
            'x-request-id': uuidv4()
        },
        body: requestBody
    });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response;
}

export {
    buildRequestBody,
    processStreamResponse,
    sendRequest
}; 