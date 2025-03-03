export const requireAuth = (req, res, next) => {
    // 检查会话是否已认证
    if (req.session && req.session.authenticated) {
        next();
    } else {
        // 如果是API请求，返回401状态码
        if (req.path.startsWith('/api/') || req.path.startsWith('/v1/')) {
            res.status(401).json({ error: 'Authentication required' });
        } else {
            // 如果是页面请求，重定向到登录页面
            const redirectUrl = encodeURIComponent(req.originalUrl);
            res.redirect(`/login.html?redirect=${redirectUrl}`);
        }
    }
}; 