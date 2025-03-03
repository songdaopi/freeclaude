import express from 'express';
import * as db from '../db.js';

const router = express.Router();

// 获取所有token
router.get('/', async (req, res) => {
    try {
        const [tokens, stats] = await Promise.all([
            db.getAllTokens(),
            db.getTokenStats()
        ]);

        // 确保返回的token列表是有效的
        const validTokens = tokens
            .filter(t => t && t.user_id && t.token)
            .map(t => ({
                fullToken: `${t.user_id}%3A%3A${t.token}`,
                gpt4_requests: t.gpt4_requests,
                gpt4_tokens: t.gpt4_tokens,
                usage_updated_at: t.usage_updated_at,
                minutes_since_update: t.minutes_since_update,
                is_active: t.is_active,
                gpt4_max_requests: t.gpt4_max_requests || 50
            }));

        // 获取所有活跃的token
        const activeTokens = tokens
            .filter(t => t.is_active && (!t.gpt4_requests || t.gpt4_requests < t.gpt4_max_requests))
            .map(t => `${t.user_id}%3A%3A${t.token}`);

        // 处理失败统计
        const failures = {};
        if (stats.failures && Array.isArray(stats.failures)) {
            stats.failures.forEach(f => {
                if (f && f.user_id && f.token) {
                    failures[`${f.user_id}%3A%3A${f.token}`] = {
                        failure_count: f.failure_count,
                        gpt4_requests: f.gpt4_requests,
                        gpt4_tokens: f.gpt4_tokens,
                        usage_updated_at: f.usage_updated_at,
                        gpt4_max_requests: f.gpt4_max_requests || 50
                    };
                }
            });
        }

        res.json({
            tokens: validTokens,
            currentTokens: activeTokens,
            stats: {
                total: stats.total || 0,
                active: stats.active || 0
            },
            failures
        });
    } catch (error) {
        console.error('Error getting tokens:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 添加token
router.post('/', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token || !db.isValidTokenFormat(token)) {
            return res.status(400).json({ error: 'Invalid token format' });
        }
        
        await db.addToken(token);
        res.json({ success: true });
    } catch (error) {
        console.error('Error adding token:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 删除token
router.delete('/', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) {
            return res.status(400).json({ error: 'Token is required' });
        }
        
        await db.deleteToken(token);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting token:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 更新token使用量
router.post('/:token/usage', async (req, res) => {
    try {
        console.log('收到更新token使用量请求:', req.params);
        const tokenString = decodeURIComponent(req.params.token);
        console.log('解码后的token:', tokenString);
        
        if (!tokenString) {
            console.log('Token为空');
            return res.status(400).json({ error: 'Token is required' });
        }

        // 验证token格式
        if (!db.isValidTokenFormat(tokenString)) {
            console.log('Token格式无效');
            return res.status(400).json({ error: 'Invalid token format' });
        }
        console.log('Token格式验证通过');

        const usage = await db.updateTokenUsage(tokenString);
        console.log('更新完成，使用量:', usage);
        res.json({ success: true, usage });
    } catch (error) {
        console.error('Error updating token usage:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 停用token
router.post('/:token/deactivate', async (req, res) => {
    try {
        const tokenString = decodeURIComponent(req.params.token);
        if (!tokenString) {
            return res.status(400).json({ error: 'Token is required' });
        }

        await db.deactivateToken(tokenString);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deactivating token:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 解除停用token
router.post('/:token/activate', async (req, res) => {
    try {
        const tokenString = decodeURIComponent(req.params.token);
        if (!tokenString) {
            return res.status(400).json({ error: 'Token is required' });
        }

        await db.activateToken(tokenString);
        res.json({ success: true });
    } catch (error) {
        console.error('Error activating token:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router; 