import express from 'express';
import * as db from '../db.js';
import { processStreamResponse, sendRequest } from '../proto_client.js';
import { requireAuth } from '../middleware/authMiddleware.js';

const router = express.Router();

// 验证 Authorization 头的中间件
async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid authorization token' });
    }
    
    let token = authHeader.split(' ')[1];
    let originalToken = token; // 保存原始token用于日志记录
    
    // 如果用户的token不符合格式，使用内部token池中的token
    if (!db.isValidTokenFormat(token)) {
        try {
            const nextToken = await db.getNextToken();
            if (!nextToken) {
                throw new Error('No active token available');
            }
            
            // 获取完整的token信息用于日志记录
            const tokenInfo = await db.getTokenInfo(nextToken);
            if (!tokenInfo) {
                throw new Error('Token info not found');
            }
            
            // 设置完整token
            originalToken = `${tokenInfo.user_id}%3A%3A${nextToken}`;
            token = nextToken;
            
            console.log('Using token from pool:', {
                originalToken,
                token,
                tokenInfo
            });
        } catch (error) {
            console.error('Error getting token from pool:', error);
            return res.status(503).json({ error: 'No active tokens available' });
        }
    } else {
        // 如果是用户提供的token，解析出纯token部分
        const parts = token.split('%3A%3A');
        if (parts.length === 2) {
            originalToken = token; // 保存完整token
            token = parts[1]; // 使用纯token部分
            console.log('Using user provided token:', {
                originalToken,
                token
            });
        }
    }
    
    if (!token || !originalToken) {
        console.error('Invalid token state:', { token, originalToken });
        return res.status(401).json({ error: 'Invalid token' });
    }
    
    req.authToken = token; // 纯token，用于API调用
    req.originalToken = originalToken; // 完整token，用于日志记录
    console.log('Token set in request:', {
        authToken: req.authToken,
        originalToken: req.originalToken
    });
    next();
}

// Chat completions endpoint
router.post('/completions', authMiddleware, async (req, res) => {
    try {
        const { messages, stream = false, model = 'claude-3.5-sonnet' } = req.body;
        
        if (!messages || !Array.isArray(messages)) {
            return res.status(400).json({ error: 'Invalid messages format' });
        }

        if (!req.originalToken) {
            console.error('Missing originalToken in request');
            return res.status(401).json({ error: 'Token is required' });
        }

        // 记录请求，使用完整token
        console.log('Logging chat request with token:', req.originalToken);
        const logId = await db.logChatRequest(req.originalToken, model, messages, stream);
        console.log('Chat request logged with ID:', logId);

        try {
            const response = await sendRequest(req.authToken, messages, model);

            // 如果请求成功，重置失败计数
            await db.resetTokenFailure(req.originalToken);

            if (stream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');

                let fullResponse = '';
                const streamProcessor = processStreamResponse(response);
                for await (const chunk of streamProcessor) {
                    fullResponse += chunk.choices[0].delta.content || '';
                    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
                }
                res.write('data: [DONE]\n\n');
                res.end();
                
                // 更新日志
                if (fullResponse.trim()) {
                    await db.updateChatLog(logId, fullResponse, 'success');
                } else {
                    await db.updateChatLog(logId, null, 'failed', 'No response content received');
                }
            } else {
                let fullResponse = '';
                const streamProcessor = processStreamResponse(response);
                for await (const chunk of streamProcessor) {
                    fullResponse += chunk.choices[0].delta.content || '';
                }

                // 更新日志
                if (fullResponse.trim()) {
                    await db.updateChatLog(logId, fullResponse, 'success');
                    res.json({
                        choices: [{
                            message: {
                                role: 'assistant',
                                content: fullResponse
                            },
                            index: 0
                        }]
                    });
                } else {
                    await db.updateChatLog(logId, null, 'failed', 'No response content received');
                    res.status(500).json({ error: 'No response content received' });
                }
            }
        } catch (error) {
            await db.recordTokenFailure(req.originalToken);
            await db.updateChatLog(logId, null, 'failed', error.message);
            throw error;
        }
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 获取chat日志
router.get('/logs', requireAuth, (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 20;
        const status = req.query.status || null;

        const result = db.getChatLogs(page, pageSize, status);
        res.json(result);
    } catch (err) {
        console.error('Error getting chat logs:', err);
        res.status(500).json({ error: 'Failed to get chat logs' });
    }
});

// 获取单条日志详情
router.get('/logs/:id', requireAuth, (req, res) => {
    try {
        const id = parseInt(req.params.id);
        if (isNaN(id)) {
            return res.status(400).json({ error: 'Invalid log ID' });
        }

        const log = db.getChatLogDetail(id);
        if (!log) {
            return res.status(404).json({ error: 'Log not found' });
        }

        res.json(log);
    } catch (err) {
        console.error('Error getting chat log detail:', err);
        res.status(500).json({ error: 'Failed to get chat log detail' });
    }
});

// Chat API
router.post('/', async (req, res) => {
    const { messages, model = 'gpt-4', stream = false } = req.body;
    const token = req.headers['x-token'];

    if (!token) {
        return res.status(401).json({ error: 'Token is required' });
    }

    // 验证token格式
    if (!db.isValidTokenFormat(token)) {
        return res.status(400).json({ error: 'Invalid token format' });
    }

    let logId;
    try {
        // 记录请求，注意参数顺序：token, model, messages, isStream
        console.log('Logging chat request with token:', token);
        logId = await db.logChatRequest(token, model, messages, stream);
        console.log('Chat request logged with ID:', logId);

        // 调用OpenAI API
        const response = await callOpenAI(token, messages, model, stream);
        
        // 更新日志
        await db.updateChatLog(logId, response, 'success');
        
        res.json(response);
    } catch (error) {
        console.error('Error in chat API:', error);
        
        // 更新日志
        if (logId) {
            await db.updateChatLog(logId, null, 'error', error.message);
        }
        
        res.status(500).json({ error: error.message });
    }
});

export default router; 