import express from 'express';
import crypto from 'crypto';
import * as db from '../db.js';

const router = express.Router();

// 生成新的SK
router.post('/', async (req, res) => {
    try {
        // 生成一个随机的SK
        const sk = 'sk-' + crypto.randomBytes(24).toString('hex');
        const { note } = req.body;
        await db.addSecretKey(sk, note);
        res.json({ sk });
    } catch (error) {
        console.error('Error creating SK:', error);
        res.status(500).json({ error: 'Failed to create SK' });
    }
});

// 获取所有SK
router.get('/', async (req, res) => {
    try {
        const sks = await db.getAllSecretKeys();
        res.json(sks);
    } catch (error) {
        console.error('Error getting SKs:', error);
        res.status(500).json({ error: 'Failed to get SKs' });
    }
});

// 更新SK备注
router.put('/:sk/note', async (req, res) => {
    try {
        const { sk } = req.params;
        const { note } = req.body;
        await db.updateSecretKeyNote(sk, note);
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating SK note:', error);
        res.status(500).json({ error: 'Failed to update SK note' });
    }
});

// 删除SK
router.delete('/:sk', async (req, res) => {
    try {
        await db.deleteSecretKey(req.params.sk);
        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting SK:', error);
        res.status(500).json({ error: 'Failed to delete SK' });
    }
});

export default router; 