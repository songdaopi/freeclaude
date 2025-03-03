import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';
import fs from 'fs';
import session from 'express-session';
import cookieParser from 'cookie-parser';

import tokenRoutes from './routes/token.js';
import chatRoutes from './routes/chat.js';
import authRoutes from './routes/auth.js';
import skRoutes from './routes/sk.js';
import { requireAuth } from './middleware/authMiddleware.js';
import { validateSecretKey } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// 基础中间件
app.use(cors());
app.use(express.json({limit: '100mb'}));
app.use(express.urlencoded({limit: '100mb', extended: true}));
app.use(cookieParser());

// 会话配置
app.use(session({
    secret: '8f4e91c7d2b6a5309e87f1234d9c0b8a6f3d2e5c8b7a4109f2e5d8c7b4a3096',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,  // 允许在HTTP下发送cookie
        httpOnly: true,  // 防止XSS攻击
        maxAge: 24 * 60 * 60 * 1000  // 24小时过期
    }
}));

// SK认证中间件
const skAuthMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Missing or invalid authorization token' });
    }
    
    const sk = authHeader.split(' ')[1];
    if (!validateSecretKey(sk)) {
        console.error('Invalid SK:', sk);
        return res.status(401).json({ error: 'Invalid SK' });
    }
    
    next();
};

// 登录页面和认证路由不需要认证
app.use('/login.html', express.static(path.join(__dirname, 'public/login.html')));
app.use('/auth', authRoutes);

// Chat API 使用 SK 认证
app.use('/v1/chat', skAuthMiddleware, chatRoutes);

// 其他所有路由都需要密码认证
app.use(requireAuth);

// 静态文件和管理API路由
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/tokens', tokenRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/sk', skRoutes);

const PORT = 6543;

// 只启动HTTP服务器
app.listen(PORT, () => {
    console.log(`HTTP Server is running on port ${PORT}`);
}); 