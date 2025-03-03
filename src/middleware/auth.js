import * as db from '../db.js';

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

export default authMiddleware; 