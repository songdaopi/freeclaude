import initSqlJs from 'sql.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = path.join(__dirname, '../db/tokens.db');

let db;
let SQL;

// 初始化数据库
async function initDb() {
    SQL = await initSqlJs();
    
    try {
        // 尝试读取现有数据库文件
        const buffer = await fs.readFile(DB_PATH);
        db = new SQL.Database(new Uint8Array(buffer));
        console.log('成功加载现有数据库');
    } catch (err) {
        console.log('创建新数据库:', err.message);
        // 如果文件不存在，创建新数据库
        db = new SQL.Database();
    }
    
    // 创建tokens表（如果不存在）
    db.run(`
        CREATE TABLE IF NOT EXISTS tokens (
            user_id TEXT,
            token TEXT,
            gpt4_requests INTEGER DEFAULT 0,
            gpt4_tokens INTEGER DEFAULT 0,
            gpt4_max_requests INTEGER DEFAULT 50,
            usage_updated_at TEXT,
            is_active INTEGER DEFAULT 1,
            failure_count INTEGER DEFAULT 0,
            PRIMARY KEY (user_id, token)
        )
    `);
    console.log('检查tokens表完成');

    // 创建chat_logs表（如果不存在）
    db.exec(`
        CREATE TABLE IF NOT EXISTS chat_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT NOT NULL,
            model TEXT NOT NULL,
            messages TEXT NOT NULL,
            response TEXT,
            status TEXT DEFAULT 'pending',
            error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            is_stream INTEGER DEFAULT 0
        )
    `);
    console.log('检查chat_logs表完成');
    
    // 创建secret_keys表（如果不存在）
    db.exec(`
        CREATE TABLE IF NOT EXISTS secret_keys (
            sk TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            last_used_at TEXT,
            is_active INTEGER DEFAULT 1,
            note TEXT,
            call_count INTEGER DEFAULT 0
        )
    `);
    console.log('检查secret_keys表完成');
    
    // 检查note列是否存在，如果不存在则添加
    try {
        db.exec("SELECT note FROM secret_keys LIMIT 1");
    } catch (err) {
        if (err.message.includes('no such column')) {
            console.log('添加note列到secret_keys表');
            db.exec("ALTER TABLE secret_keys ADD COLUMN note TEXT");
        }
    }

    // 检查call_count列是否存在，如果不存在则添加
    try {
        db.exec("SELECT call_count FROM secret_keys LIMIT 1");
    } catch (err) {
        if (err.message.includes('no such column')) {
            console.log('添加call_count列到secret_keys表');
            db.exec("ALTER TABLE secret_keys ADD COLUMN call_count INTEGER DEFAULT 0");
        }
    }
    
    // 保存数据库文件
    await saveDb();
    console.log('保存数据库完成');
}

// 保存数据库到文件
async function saveDb() {
    const data = db.export();
    await fs.writeFile(DB_PATH, Buffer.from(data));
}

// 初始化数据库
await initDb();

// 解析token字符串
function parseTokenString(tokenString) {
    const separator = tokenString.includes('%3A%3A') ? '%3A%3A' : '::';
    const parts = tokenString.split(separator);
    
    if (parts.length !== 2) {
        throw new Error('Invalid token format');
    }

    const [userId, token] = parts;
    if (!userId || !token) {
        throw new Error('Invalid token format');
    }

    return { userId, token };
}

// 添加token
export async function addToken(tokenString) {
    try {
        const { userId, token } = parseTokenString(tokenString);
        db.run('INSERT OR IGNORE INTO tokens (user_id, token) VALUES (?, ?)', [userId, token]);
        await saveDb();
    } catch (err) {
        console.error('Error adding token:', err);
        throw err;
    }
}

// 获取所有活跃的token
export function getActiveTokens() {
    try {
        const stmt = db.prepare(`
            SELECT * FROM tokens 
            WHERE is_active = 1 
            AND (gpt4_requests IS NULL OR gpt4_requests < gpt4_max_requests)
        `);
        const tokens = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            tokens.push({
                ...row,
                fullToken: `${row.user_id}%3A%3A${row.token}`
            });
        }
        stmt.free();
        return tokens;
    } catch (err) {
        console.error('Error getting active tokens:', err);
        throw err;
    }
}

// 获取所有token（包括非活跃的）
export function getAllTokens() {
    try {
        const stmt = db.prepare(`
            SELECT *, 
                   CASE 
                       WHEN usage_updated_at IS NOT NULL 
                       THEN CAST(
                           (julianday(strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')) - 
                            julianday(usage_updated_at)) * 24 * 60 AS INTEGER)
                       ELSE NULL 
                   END as minutes_since_update
            FROM tokens
        `);
        const tokens = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            tokens.push({
                ...row,
                fullToken: `${row.user_id}%3A%3A${row.token}`
            });
        }
        stmt.free();
        return tokens;
    } catch (err) {
        console.error('Error getting all tokens:', err);
        throw err;
    }
}

// 删除token
export async function deleteToken(tokenString) {
    try {
        const { userId, token } = parseTokenString(tokenString);
        db.run('DELETE FROM tokens WHERE user_id = ? AND token = ?', [userId, token]);
        await saveDb();
    } catch (err) {
        console.error('Error deleting token:', err);
        throw err;
    }
}

// 记录token使用
export async function recordTokenUse(tokenString) {
    try {
        let userId, token;
        if (tokenString.includes('%3A%3A')) {
            // 如果是完整格式的token
            ({ userId, token } = parseTokenString(tokenString));
        } else {
            // 如果是纯token
            token = tokenString;
            // 查找对应的userId
            const stmt = db.prepare('SELECT user_id FROM tokens WHERE token = ? AND is_active = 1');
            const result = stmt.step() ? stmt.getAsObject() : null;
            stmt.free();
            if (!result) {
                console.warn('Token not found or inactive:', token);
                return; // 如果找不到token，静默失败
            }
            userId = result.user_id;
        }

        // 更新使用时间
        const now = new Date().toISOString();
        db.run(`
            UPDATE tokens 
            SET usage_updated_at = ?
            WHERE user_id = ? AND token = ?
        `, [now, userId, token]);
        
        await saveDb();
    } catch (err) {
        console.error('Error recording token use:', err);
        // 不抛出错误，让程序继续运行
    }
}

// 记录token失败
export async function recordTokenFailure(tokenString) {
    try {
        let userId, token;
        if (tokenString.includes('%3A%3A')) {
            // 如果是完整格式的token
            ({ userId, token } = parseTokenString(tokenString));
        } else {
            // 如果是纯token
            token = tokenString;
            // 查找对应的userId
            const stmt = db.prepare('SELECT user_id FROM tokens WHERE token = ? AND is_active = 1');
            const result = stmt.step() ? stmt.getAsObject() : null;
            stmt.free();
            if (!result) {
                console.warn('Token not found or inactive:', token);
                return; // 如果找不到token，静默失败
            }
            userId = result.user_id;
        }

        db.run(`
            UPDATE tokens 
            SET failure_count = failure_count + 1,
                is_active = CASE 
                    WHEN failure_count + 1 >= 3 THEN 0 
                    ELSE 1 
                END 
            WHERE user_id = ? AND token = ?
        `, [userId, token]);
        await saveDb();
    } catch (err) {
        console.error('Error recording token failure:', err);
        throw err;
    }
}

// 重置token失败计数
export async function resetTokenFailure(tokenString) {
    try {
        let userId, token;
        if (tokenString.includes('%3A%3A')) {
            // 如果是完整格式的token
            ({ userId, token } = parseTokenString(tokenString));
        } else {
            // 如果是纯token
            token = tokenString;
            // 查找对应的userId
            const stmt = db.prepare('SELECT user_id FROM tokens WHERE token = ? AND is_active = 1');
            const result = stmt.step() ? stmt.getAsObject() : null;
            stmt.free();
            if (!result) {
                console.warn('Token not found or inactive:', token);
                return; // 如果找不到token，静默失败
            }
            userId = result.user_id;
        }

        db.run('UPDATE tokens SET failure_count = 0 WHERE user_id = ? AND token = ?', [userId, token]);
        await saveDb();
    } catch (err) {
        console.error('Error resetting token failure:', err);
        throw err;
    }
}

// 获取下一个可用token（轮询方式）
let currentTokenIndex = 0;
export function getNextToken() {
    try {
        // 获取所有活跃且未超限的token
        const stmt = db.prepare(`
            SELECT user_id, token, gpt4_requests, gpt4_max_requests
            FROM tokens 
            WHERE is_active = 1 
            AND (gpt4_requests IS NULL OR gpt4_requests < gpt4_max_requests)
        `);
        
        const tokens = [];
        while (stmt.step()) {
            const row = stmt.getAsObject();
            tokens.push(row);
        }
        stmt.free();

        if (tokens.length === 0) {
            throw new Error('No active tokens available');
        }
        
        currentTokenIndex = (currentTokenIndex + 1) % tokens.length;
        const token = tokens[currentTokenIndex].token;
        
        // 记录使用情况
        recordTokenUse(`${tokens[currentTokenIndex].user_id}%3A%3A${token}`).catch(console.error);
        
        return token;
    } catch (err) {
        console.error('Error getting next token:', err);
        throw err;
    }
}

// 验证token格式
export function isValidTokenFormat(tokenString) {
    try {
        if (!tokenString || typeof tokenString !== 'string') {
            return false;
        }
        
        if (!tokenString.includes('::') && !tokenString.includes('%3A%3A')) {
            return false;
        }

        const parts = tokenString.includes('%3A%3A') 
            ? tokenString.split('%3A%3A')
            : tokenString.split('::');

        if (parts.length !== 2) {
            return false;
        }

        const [userId, token] = parts;
        if (!userId || !token) {
            return false;
        }

        if (token.length < 10) {
            return false;
        }

        return true;
    } catch (err) {
        return false;
    }
}

// 更新token使用量
export async function updateTokenUsage(tokenString) {
    try {
        if (!isValidTokenFormat(tokenString)) {
            throw new Error('Invalid token format');
        }

        const { userId, token } = parseTokenString(tokenString);
        
        const url = `https://www.cursor.com/api/usage?user=${userId}`;
        const headers = {
            'accept': '*/*',
            'cookie': `WorkosCursorSessionToken=${userId}%3A%3A${token}`,
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        };

        const response = await fetch(url, { headers });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        const gpt4Usage = data['gpt-4'] || { numRequests: 0, numTokens: 0, maxRequestUsage: 50 };
        const maxRequests = gpt4Usage.maxRequestUsage || 50; // 使用API返回的值，默认为50

        const updateTime = db.exec("SELECT strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime') as current_time")[0].values[0][0];
        console.log('当前更新时间:', updateTime);
        console.log('更新使用量:', {
            requests: gpt4Usage.numRequests,
            maxRequests: maxRequests,
            isActive: gpt4Usage.numRequests < maxRequests
        });

        db.run(`
            UPDATE tokens 
            SET gpt4_requests = ?,
                gpt4_tokens = ?,
                gpt4_max_requests = ?,
                usage_updated_at = ?,
                is_active = CASE 
                    WHEN failure_count >= 3 THEN 0
                    WHEN ? >= ? THEN 0
                    ELSE 1
                END
            WHERE user_id = ? AND token = ?
        `, [
            gpt4Usage.numRequests, 
            gpt4Usage.numTokens, 
            maxRequests, 
            updateTime,
            gpt4Usage.numRequests,
            maxRequests,
            userId, 
            token
        ]);
        
        // 验证更新
        const updated = db.exec(`
            SELECT usage_updated_at, 
                   CASE 
                       WHEN usage_updated_at IS NOT NULL 
                       THEN CAST(
                           (julianday(strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')) - 
                            julianday(usage_updated_at)) * 24 * 60 AS INTEGER)
                       ELSE NULL 
                   END as minutes_since_update 
            FROM tokens 
            WHERE user_id = ? AND token = ?
        `, [userId, token])[0];
        console.log('更新后的时间信息:', updated.values[0]);
        
        await saveDb();
        
        return {
            requests: gpt4Usage.numRequests,
            tokens: gpt4Usage.numTokens,
            maxRequests: maxRequests
        };
    } catch (err) {
        console.error('Error updating token usage:', err);
        throw err;
    }
}

// 获取token统计信息
export function getTokenStats() {
    try {
        const total = db.exec('SELECT COUNT(*) as count FROM tokens')[0].values[0][0];
        const active = db.exec(`
            SELECT COUNT(*) as count 
            FROM tokens 
            WHERE is_active = 1 
            AND (gpt4_requests IS NULL OR gpt4_requests < gpt4_max_requests)
        `)[0].values[0][0];
        const failuresResult = db.exec('SELECT user_id, token, failure_count, gpt4_requests, gpt4_tokens, usage_updated_at FROM tokens WHERE failure_count > 0');
        
        const failures = failuresResult.length > 0 ? failuresResult[0].values.map(row => ({
            token: `${row[0]}%3A%3A${row[1]}`,
            failure_count: row[2],
            gpt4_requests: row[3],
            gpt4_tokens: row[4],
            usage_updated_at: row[5]
        })) : [];

        return {
            total,
            active,
            failures
        };
    } catch (err) {
        console.error('Error getting token stats:', err);
        throw err;
    }
}

// 获取数据库实例
function getDb() {
    if (!db) {
        throw new Error('Database not initialized');
    }
    return db;
}

// 记录chat请求
export function logChatRequest(token, model, messages, isStream = false) {
    try {
        // 验证token格式
        if (!isValidTokenFormat(token)) {
            throw new Error('Invalid token format');
        }

        // 解析token
        const { userId, token: pureToken } = parseTokenString(token);
        if (!userId || !pureToken) {
            throw new Error('Failed to parse token');
        }

        // 获取当前时间
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

        // 插入日志记录
        const stmt = db.prepare(`
            INSERT INTO chat_logs (
                token,
                model,
                messages,
                status,
                created_at,
                updated_at,
                is_stream
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        // 将messages转换为JSON字符串
        const messagesJson = JSON.stringify(messages);

        stmt.run([
            token,  // 使用完整token
            model,
            messagesJson,
            'pending',
            now,
            now,
            isStream ? 1 : 0
        ]);
        stmt.free();

        // 获取插入的记录ID
        const result = db.exec('SELECT last_insert_rowid()');
        const logId = result[0].values[0][0];

        // 保存数据库
        saveDb();

        return logId;
    } catch (err) {
        console.error('Error logging chat request:', err);
        throw err;
    }
}

// 更新chat日志
export async function updateChatLog(id, response, status = 'success', error = null) {
    try {
        // 获取当前时间
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

        const stmt = db.prepare(`
            UPDATE chat_logs 
            SET response = ?, 
                status = ?, 
                error = ?, 
                updated_at = ?
            WHERE id = ?
        `);
        stmt.run([response, status, error, now, id]);
        stmt.free();

        // 保存数据库
        await saveDb();
    } catch (err) {
        console.error('Error updating chat log:', err);
        throw err;
    }
}

// 获取chat日志
export function getChatLogs(page = 1, pageSize = 20, status = null) {
    try {
        const offset = (page - 1) * pageSize;
        
        // 构建查询条件
        let whereClause = '';
        let params = [];
        
        if (status) {
            whereClause = 'WHERE status = ?';
            params.push(status);
        }
        
        // 获取总记录数
        const countResult = db.exec(`SELECT COUNT(*) as total FROM chat_logs ${whereClause}`, params)[0];
        const total = countResult.values[0][0];
        
        // 获取分页数据，只返回基本信息
        const logsResult = db.exec(`
            SELECT id, token, model, status, created_at, updated_at, error
            FROM chat_logs 
            ${whereClause}
            ORDER BY created_at DESC 
            LIMIT ${pageSize} OFFSET ${offset}
        `, params);
        
        // 处理每条记录
        const logs = logsResult && logsResult[0] ? logsResult[0].values.map(row => ({
            id: row[0],
            token: row[1],
            model: row[2],
            status: row[3],
            created_at: row[4],
            updated_at: row[5],
            error: row[6]
        })) : [];
        
        return {
            total,
            logs
        };
    } catch (err) {
        console.error('Error getting chat logs:', err);
        return {
            total: 0,
            logs: []
        };
    }
}

// 获取单条日志详情
export function getChatLogDetail(id) {
    try {
        const result = db.exec(`
            SELECT id, token, model, messages, response, status, error, created_at, updated_at
            FROM chat_logs 
            WHERE id = ?
        `, [id]);
        
        if (!result || !result[0] || !result[0].values.length) {
            return null;
        }
        
        const row = result[0].values[0];
        let messages;
        try {
            messages = JSON.parse(row[3]);
        } catch (e) {
            messages = [];
            console.error('Error parsing messages:', e);
        }
        
        return {
            id: row[0],
            token: row[1],
            model: row[2],
            messages: messages,
            response: row[4],
            status: row[5],
            error: row[6],
            created_at: row[7],
            updated_at: row[8]
        };
    } catch (err) {
        console.error('Error getting chat log detail:', err);
        throw err;
    }
}

// 获取token信息
export function getTokenInfo(token) {
    try {
        const stmt = db.prepare(`
            SELECT user_id, token, is_active, gpt4_requests, gpt4_max_requests
            FROM tokens 
            WHERE token = ? AND is_active = 1
        `);
        stmt.bind([token]);
        const result = stmt.step() ? stmt.getAsObject() : null;
        stmt.free();
        return result;
    } catch (err) {
        console.error('Error getting token info:', err);
        throw err;
    }
}

// 手动停用token
export async function deactivateToken(tokenString) {
    try {
        const { userId, token } = parseTokenString(tokenString);
        db.run(`
            UPDATE tokens 
            SET is_active = 0 
            WHERE user_id = ? AND token = ?
        `, [userId, token]);
        await saveDb();
    } catch (err) {
        console.error('Error deactivating token:', err);
        throw err;
    }
}

// 解除停用token
export async function activateToken(tokenString) {
    try {
        const { userId, token } = parseTokenString(tokenString);
        db.run(`
            UPDATE tokens 
            SET is_active = 1,
                failure_count = 0
            WHERE user_id = ? AND token = ?
        `, [userId, token]);
        await saveDb();
    } catch (err) {
        console.error('Error activating token:', err);
        throw err;
    }
}

// 添加SK
export async function addSecretKey(sk, note = '') {
    try {
        const now = new Date().toISOString();
        db.run('INSERT INTO secret_keys (sk, created_at, note) VALUES (?, ?, ?)', [sk, now, note]);
        await saveDb();
    } catch (err) {
        console.error('Error adding SK:', err);
        throw err;
    }
}

// 更新SK备注
export async function updateSecretKeyNote(sk, note) {
    try {
        db.run('UPDATE secret_keys SET note = ? WHERE sk = ?', [note, sk]);
        await saveDb();
    } catch (err) {
        console.error('Error updating SK note:', err);
        throw err;
    }
}

// 获取所有SK
export function getAllSecretKeys() {
    try {
        const stmt = db.prepare(`
            SELECT *, 
                   CASE 
                       WHEN last_used_at IS NOT NULL 
                       THEN CAST(
                           (julianday(strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime')) - 
                            julianday(last_used_at)) * 24 * 60 AS INTEGER)
                       ELSE NULL 
                   END as minutes_since_last_use
            FROM secret_keys
            ORDER BY created_at DESC
        `);
        const sks = [];
        while (stmt.step()) {
            sks.push(stmt.getAsObject());
        }
        stmt.free();
        return sks;
    } catch (err) {
        console.error('Error getting SKs:', err);
        throw err;
    }
}

// 删除SK
export async function deleteSecretKey(sk) {
    try {
        db.run('DELETE FROM secret_keys WHERE sk = ?', [sk]);
        await saveDb();
    } catch (err) {
        console.error('Error deleting SK:', err);
        throw err;
    }
}

// 验证SK
export function validateSecretKey(sk) {
    try {
        const stmt = db.prepare('SELECT is_active FROM secret_keys WHERE sk = ?');
        stmt.bind([sk]);
        const row = stmt.step() ? stmt.getAsObject() : null;
        stmt.free();
        
        if (!row) {
            console.log('SK not found:', sk);
            return false;
        }
        
        // 更新最后使用时间和调用次数
        const now = new Date().toISOString();
        db.run('UPDATE secret_keys SET last_used_at = ?, call_count = call_count + 1 WHERE sk = ?', [now, sk]);
        saveDb().catch(console.error);
        
        return row.is_active === 1;
    } catch (err) {
        console.error('Error validating SK:', err);
        return false;
    }
} 