import express from 'express';
import bcrypt from 'bcryptjs';

const router = express.Router();

// 这个密码hash是通过bcrypt.hashSync生成的
const hash = bcrypt.hashSync('admin123', 10);
const PASSWORD_HASH = hash;

router.post('/login', (req, res) => {
    const { password } = req.body;
    
    if (!password) {
        return res.status(400).json({ error: 'Password is required' });
    }

    // 验证密码
    if (bcrypt.compareSync(password, PASSWORD_HASH)) {
        // 设置会话
        req.session.authenticated = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

router.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

export default router; 