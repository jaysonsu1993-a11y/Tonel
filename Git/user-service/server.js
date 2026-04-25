require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 9006;
const JWT_SECRET = process.env.JWT_SECRET || 'tonel-secret-key-change-in-production';

// 微信配置
const WECHAT_APPID = process.env.WECHAT_APPID || '';
const WECHAT_SECRET = process.env.WECHAT_SECRET || '';

// 中间件
app.use(cors());
app.use(express.json());

// 数据库初始化
const dbPath = path.join(__dirname, 'users.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    // 用户表
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        union_id TEXT UNIQUE NOT NULL,
        open_id TEXT,
        nickname TEXT,
        avatar_url TEXT,
        membership_type TEXT DEFAULT 'free',
        membership_expires_at INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
    )`);

    // 会话表
    db.run(`CREATE TABLE IF NOT EXISTS user_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(id),
        token TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
    )`);
});

// JWT 工具
function generateToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch (e) {
        return null;
    }
}

// 认证中间件
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const token = authHeader.slice(7);
    const decoded = verifyToken(token);
    if (!decoded) {
        return res.status(401).json({ error: 'Invalid token' });
    }
    
    req.userId = decoded.userId;
    next();
}

// ========== 微信 OAuth 回调 ==========
app.get('/api/auth/wechat/callback', async (req, res) => {
    const { code, state } = req.query;
    
    if (!code) {
        return res.status(400).json({ error: 'Missing code parameter' });
    }

    try {
        // 1. 用 code 换取 access_token
        const tokenUrl = `https://api.weixin.qq.com/sns/oauth2/access_token?appid=${WECHAT_APPID}&secret=${WECHAT_SECRET}&code=${code}&grant_type=authorization_code`;
        const tokenRes = await axios.get(tokenUrl);
        const { access_token, openid, unionid, errcode, errmsg } = tokenRes.data;

        if (errcode) {
            console.error('WeChat token error:', errcode, errmsg);
            return res.status(400).json({ error: 'WeChat auth failed', detail: errmsg });
        }

        // 2. 获取用户信息
        const userInfoUrl = `https://api.weixin.qq.com/sns/userinfo?access_token=${access_token}&openid=${openid}`;
        const userRes = await axios.get(userInfoUrl);
        const { nickname, headimgurl, unionid: userUnionId } = userRes.data;

        const unionId = unionid || userUnionId || openid;

        // 3. 查找或创建用户
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE union_id = ?', [unionId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        let userId;
        if (user) {
            // 更新用户信息
            userId = user.id;
            db.run(
                'UPDATE users SET nickname = ?, avatar_url = ?, updated_at = strftime(\'%s\', \'now\') WHERE id = ?',
                [nickname, headimgurl, userId]
            );
        } else {
            // 创建新用户
            const result = await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO users (union_id, open_id, nickname, avatar_url) VALUES (?, ?, ?, ?)',
                    [unionId, openid, nickname, headimgurl],
                    function(err) {
                        if (err) reject(err);
                        else resolve(this.lastID);
                    }
                );
            });
            userId = result;
        }

        // 4. 生成 JWT Token
        const token = generateToken(userId);
        const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60; // 7天

        // 保存会话
        db.run('INSERT INTO user_sessions (user_id, token, expires_at) VALUES (?, ?, ?)', [userId, token, expiresAt]);

        // 5. 返回结果（前端可以用这个 token）
        res.json({
            success: true,
            token,
            user: {
                id: userId,
                unionId: unionId,
                nickname: nickname || '微信用户',
                avatarUrl: headimgurl || '',
                membershipType: user?.membership_type || 'free'
            }
        });

    } catch (error) {
        console.error('WeChat callback error:', error);
        res.status(500).json({ error: 'Internal server error', detail: error.message });
    }
});

// ========== 获取用户信息 ==========
app.get('/api/user/profile', authMiddleware, (req, res) => {
    db.get('SELECT * FROM users WHERE id = ?', [req.userId], (err, user) => {
        if (err || !user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({
            id: user.id,
            unionId: user.union_id,
            nickname: user.nickname,
            avatarUrl: user.avatar_url,
            membershipType: user.membership_type,
            membershipExpiresAt: user.membership_expires_at
        });
    });
});

// ========== 验证 Token（供信令服务器调用） ==========
app.post('/api/auth/verify', (req, res) => {
    const { token } = req.body;
    
    if (!token) {
        return res.status(400).json({ error: 'Missing token' });
    }

    const decoded = verifyToken(token);
    if (!decoded) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    // 获取用户信息
    db.get('SELECT * FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({
            valid: true,
            user: {
                id: user.id,
                unionId: user.union_id,
                nickname: user.nickname,
                avatarUrl: user.avatar_url,
                membershipType: user.membership_type
            }
        });
    });
});

// ========== 健康检查 ==========
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 启动服务
app.listen(PORT, '0.0.0.0', () => {
    console.log(`User service running on port ${PORT}`);
    console.log(`WeChat AppID: ${WECHAT_APPID ? 'Configured' : 'NOT CONFIGURED'}`);
});
