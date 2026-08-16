require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    if (process.env.VERCEL) {
        console.error('[SECURITY] CRITICAL: JWT_SECRET env variable is not set! Admin auth is unsafe.');
    } else {
        throw new Error('FATAL: JWT_SECRET environment variable is required. Please set it in .env or Vercel settings.');
    }
}

// Cho phep cac domain hop le
const ALLOWED_ORIGINS = [
    'https://dhtk.vercel.app',
    'https://thohong.top',
    'https://www.thohong.top',
    'https://thohong.vercel.app',
    'https://thohong.top',
    'https://www.thohong.top',
    'http://localhost:3000',
    'http://localhost:3500'
];
app.use(cors({
    origin: (origin, callback) => {
        // Cho phep request khong co origin (Postman, curl, mobile app)
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error('CORS: Domain not allowed'));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS']
}));
app.use(express.json({ limit: '50mb' }));

app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1y',
    etag: true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
    }
}));

// --- NATIVE TURSO HTTP CLIENT ---
async function executeTurso(sql, args = []) {
    let url = (process.env.TURSO_DATABASE_URL || 'https://fallback.turso.io').trim();
    if (url.startsWith('libsql://')) url = url.replace('libsql://', 'https://');
    
    const token = (process.env.TURSO_AUTH_TOKEN || '').trim();

    const reqBody = {
        requests: [
            { type: "execute", stmt: { sql, args: args.map(a => ({ type: "text", value: String(a) })) } },
            { type: "close" }
        ]
    };

    const res = await fetch(`${url}/v2/pipeline`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(reqBody)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Turso HTTP Error: ${res.status} ${res.statusText} - ${text}`);
    }

    const data = await res.json();
    const execResult = data.results[0];
    
    if (execResult.type === 'error') {
        throw new Error(execResult.error.message);
    }
    
    const cols = execResult.response.result.cols.map(c => c.name);
    const rows = execResult.response.result.rows.map(r => {
        const rowData = {};
        r.forEach((cell, idx) => {
            rowData[cols[idx]] = cell.value;
        });
        return rowData;
    });

    return { rows };
}

async function executeBatchTurso(stmts) {
    let url = (process.env.TURSO_DATABASE_URL || 'https://fallback.turso.io').trim();
    if (url.startsWith('libsql://')) url = url.replace('libsql://', 'https://');
    const token = (process.env.TURSO_AUTH_TOKEN || '').trim();

    const requests = stmts.map(stmt => ({
        type: "execute",
        stmt: { sql: stmt.sql, args: stmt.args.map(a => ({ type: "text", value: String(a) })) }
    }));
    requests.push({ type: "close" });

    const reqBody = { requests };
    const res = await fetch(`${url}/v2/pipeline`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(reqBody)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Turso Batch Error: ${res.status} ${res.statusText} - ${text}`);
    }

    const data = await res.json();
    return data;
}

const db = { 
    execute: (obj) => {
        if (typeof obj === 'string') return executeTurso(obj, []);
        return executeTurso(obj.sql, obj.args || []);
    },
    executeBatch: (stmts) => {
        return executeBatchTurso(stmts);
    }
};

// Cache index.html in memory to avoid repeated disk reads (speeds up Vercel cold starts)
let _cachedHtml = '';
function getCachedHtml() {
    if (_cachedHtml) return _cachedHtml;
    const possiblePaths = [
        path.join(process.cwd(), 'public', 'index.html'),
        path.join(__dirname, 'public', 'index.html'),
        path.join(__dirname, 'index.html')
    ];
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            _cachedHtml = fs.readFileSync(p, 'utf8');
            return _cachedHtml;
        }
    }
    return '';
}

// --- DATABASE INITIALIZATION WITH TURSO ---
async function initDB() {
    // Xóa chặn initDB trên Vercel để khởi tạo DB mới cho thohong
    // if (process.env.VERCEL) {
    //     console.log('[DB] Running on Vercel, skipping table creation & seeding.');
    //     return;
    // }

    // Create Tables
    await db.execute(`
        CREATE TABLE IF NOT EXISTS admin_creds (
            username TEXT PRIMARY KEY,
            password_hash TEXT NOT NULL
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sku TEXT,
            price INTEGER DEFAULT 0,
            costPrice INTEGER DEFAULT 0,
            imageUrl TEXT,
            category TEXT,
            quantity INTEGER DEFAULT 0,
            status TEXT DEFAULT 'active',
            discountGroup TEXT,
            details TEXT
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS pos_sync_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            status TEXT NOT NULL,
            total_products INTEGER DEFAULT 0,
            matched_count INTEGER DEFAULT 0,
            error_message TEXT
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS daily_stats (
            date TEXT NOT NULL,
            referrer TEXT NOT NULL DEFAULT '',
            url TEXT NOT NULL DEFAULT '',
            product_id TEXT NOT NULL DEFAULT '',
            view_count INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (date, referrer, url, product_id)
        )
    `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS blog_posts (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            slug TEXT UNIQUE NOT NULL,
            summary TEXT DEFAULT '',
            content TEXT NOT NULL DEFAULT '',
            keyword TEXT DEFAULT '',
            cover_image TEXT DEFAULT '',
            status TEXT DEFAULT 'draft',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            indexed_at TEXT DEFAULT ''
        )
    `);
    try {
        await db.execute("ALTER TABLE blog_posts ADD COLUMN indexed_at TEXT DEFAULT ''");
    } catch(e) {}

    await db.execute(`
        CREATE TABLE IF NOT EXISTS seo_keywords (
            id TEXT PRIMARY KEY,
            keyword TEXT NOT NULL UNIQUE,
            difficulty TEXT DEFAULT 'Trung bình',
            reason TEXT DEFAULT '',
            status TEXT DEFAULT 'pending',
            created_at TEXT NOT NULL
        )
    `);

    // Seed default admin if not exists
    const adminCountResult = await db.execute('SELECT COUNT(*) as count FROM admin_creds');
    const adminCount = adminCountResult.rows[0]?.count || 0;
    if (Number(adminCount) === 0) {
        const defaultUsername = process.env.ADMIN_USERNAME || 'admin';
        const defaultHash = process.env.ADMIN_PASSWORD_HASH || '6eb330c1157c1a82ee20ed3d76b1f2cbcf81f9b36ed753696805b53d4411130d'; // dhtk2024
        await db.execute({
            sql: 'INSERT INTO admin_creds (username, password_hash) VALUES (?, ?)',
            args: [defaultUsername, defaultHash]
        });
        console.log(`[DB] Created default admin account: ${defaultUsername}`);
    }

    // Seed default settings if not exists
    const settingsCountResult = await db.execute('SELECT COUNT(*) as count FROM settings');
    const settingsCount = settingsCountResult.rows[0]?.count || 0;
    if (Number(settingsCount) === 0) {
        const defaultSettings = {
            bannerTitle: 'Tổng Kho Sỉ Lẻ ĐHTK',
            bannerSubtitle: 'Hệ thống đặt hàng thông minh, tự động cộng gộp chiết khấu. Đã fix lỗi gom nhóm, load chuẩn 100% dữ liệu!',
            logoText: 'ĐHTK',
            metaTitle: 'Tổng Kho Sỉ Lẻ Thỏ Hồng - Hệ Thống Đặt Hàng Thông Minh',
            metaDescription: 'Hệ thống đặt hàng sỉ lẻ thông minh Thỏ Hồng / ĐHTK, tự động tính toán chiết khấu, đồng bộ tồn kho POS Pancake trực tuyến.',
            telegramToken: process.env.TELEGRAM_TOKEN || '',
            telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
            storeName: 'Tổng Kho Thỏ Hồng',
            last_pos_sync: '0'
        };

        for (const [key, value] of Object.entries(defaultSettings)) {
            await db.execute({
                sql: 'INSERT INTO settings (key, value) VALUES (?, ?)',
                args: [key, value]
            });
        }
        console.log('[DB] Seeding default settings done.');
    }

    // Tự động dọn dẹp metaTitle cũ dính chữ V12
    try {
        await db.execute("UPDATE settings SET value = 'Tổng Kho Sỉ Lẻ Thỏ Hồng - Hệ Thống Đặt Hàng Thông Minh' WHERE key = 'metaTitle' AND value LIKE '%V12%'");
    } catch(e) {}

    // Ensure last_pos_sync exists if DB was already seeded
    try {
        await db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('last_pos_sync', '0')");
    } catch(e) {}

    // Seed default products if not exists
    // DISABLED for production to avoid dummy data appearing when DB is emptied.
}

// --- MIDDLEWARES ---
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Unauthorized: Missing token' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Forbidden: Invalid token' });
        req.user = user;
        next();
    });
}

function sha256(string) {
    return crypto.createHash('sha256').update(string).digest('hex');
}

// --- TELEGRAM HELPER ---
async function sendTelegramMessage(token, chatId, text) {
    if (!token || !chatId) {
        console.log('[Telegram] Missing token or chatId. Skipping notification.');
        return;
    }
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML'
            })
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.description || 'Unknown Telegram Error');
        return data;
    } catch (e) {
        console.error('[Telegram Error]', e.message);
        throw e;
    }
}

async function sendTelegramPhotoMessage(token, chatId, photoUrl, captionText, blogUrl) {
    if (!token || !chatId) return;
    const cleanPhotoUrl = (photoUrl && photoUrl.startsWith('http')) ? photoUrl : null;
    
    const replyMarkup = blogUrl ? {
        inline_keyboard: [
            [{ text: '📖 Đọc Bài Viết Ngay', url: blogUrl }]
        ]
    } : undefined;

    if (cleanPhotoUrl) {
        const url = `https://api.telegram.org/bot${token}/sendPhoto`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    photo: cleanPhotoUrl,
                    caption: captionText,
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup
                })
            });
            const data = await response.json();
            if (data.ok) return data;
            console.warn('[Telegram Photo Warning] Failed sendPhoto, falling back to sendMessage:', data.description);
        } catch(e) {
            console.error('[Telegram Photo Error]', e.message);
        }
    }

    const textMessage = `${captionText}\n\n🔗 <b>Xem chi tiết:</b> <a href="${blogUrl}">${blogUrl}</a>`;
    return sendTelegramMessage(token, chatId, textMessage);
}

async function shareBlogToTelegram(fullBlogUrl, title, summary, coverImage, blogId = null, overrideToken = '', overrideChatId = '') {
    try {
        const res = await db.execute("SELECT key, value FROM settings WHERE key IN ('telegramToken', 'telegramChatId', 'telegramBlogToken', 'telegramBlogChatId', 'autoTelegramShare', 'storeName')");
        const settingsMap = {};
        (res.rows || []).forEach(r => { settingsMap[r.key] = r.value; });

        const blogTokenSetting = (settingsMap['telegramBlogToken'] || '').trim();
        const blogChatIdSetting = (settingsMap['telegramBlogChatId'] || '').trim();

        const botToken = (overrideToken || blogTokenSetting || settingsMap['telegramToken'] || '').trim();
        const chatId = (overrideChatId || blogChatIdSetting || '').trim();

        if (!botToken) {
            return { skipped: true, reason: '❌ Chưa nhập Bot Token Telegram. Vui lòng nhập Bot Token và nhấn "💾 Lưu Tất Cả Cài Đặt Telegram"!' };
        }

        if (!chatId) {
            return { skipped: true, reason: '❌ Chưa nhập Chat ID Kênh Telegram SEO ở Mục 2! Vui lòng nhập Chat ID Kênh Tin Tức (VD: -100xxxxxxxxx) vào Mục 2 và bấm "💾 Lưu Tất Cả Cài Đặt Telegram"!' };
        }

        const storeName = settingsMap['storeName'] || 'Thỏ Hồng / ĐHTK';
        const cleanSummary = (summary || '').replace(/<[^>]*>/g, '').substring(0, 200);

        const caption = `📢 <b>BÀI VIẾT MỚI TỪ ${storeName.toUpperCase()}</b>\n\n` +
                        `📌 <b>${title}</b>\n\n` +
                        `📝 <i>${cleanSummary}...</i>`;

        const result = await sendTelegramPhotoMessage(botToken, chatId, coverImage, caption, fullBlogUrl);
        console.log(`[TELEGRAM BLOG SHARE SUCCESS] Shared "${title}" to channel ${chatId}`);

        // Tự động ghi nhận mốc thời gian đã chia sẻ Telegram vào CSDL
        if (blogId) {
            try {
                await db.execute("ALTER TABLE blog_posts ADD COLUMN telegram_shared_at TEXT DEFAULT ''");
            } catch(e) {}
            const nowIso = new Date().toISOString();
            await db.execute({
                sql: "UPDATE blog_posts SET telegram_shared_at = ? WHERE id = ? OR slug = ?",
                args: [nowIso, blogId, blogId]
            });
        }

        return { success: true, result };
    } catch(e) {
        console.error('[TELEGRAM BLOG SHARE ERROR]', e.message);
        return { error: e.message };
    }
}

async function shareBlogToFacebook(fullBlogUrl, title, summary, coverImage, blogId = null, overridePageId = '', overridePageToken = '', overrideGroupId = '', overrideGroupToken = '') {
    try {
        const res = await db.execute("SELECT key, value FROM settings WHERE key IN ('fbPageId', 'fbPageToken', 'fbGroupId', 'fbGroupToken', 'autoFbShare', 'fbMsgTemplate', 'storeName')");
        const settingsMap = {};
        (res.rows || []).forEach(r => { settingsMap[r.key] = r.value; });

        const fbPageId = (overridePageId || settingsMap['fbPageId'] || '').trim();
        const fbPageToken = (overridePageToken || settingsMap['fbPageToken'] || '').trim();
        const fbGroupId = (overrideGroupId || settingsMap['fbGroupId'] || '').trim();
        const fbGroupToken = (overrideGroupToken || settingsMap['fbGroupToken'] || '').trim();
        const customTpl = (settingsMap['fbMsgTemplate'] || '').trim();
        const storeName = settingsMap['storeName'] || 'Thỏ Hồng / ĐHTK';

        if (!fbPageId && !fbGroupId) {
            return { skipped: true, reason: '❌ Chưa nhập Page ID Fanpage hoặc Group ID Facebook. Vui lòng nhập thông tin cài đặt Facebook ở Mục 3!' };
        }

        const cleanSummary = (summary || '').replace(/<[^>]*>/g, '').substring(0, 250);
        
        let message = '';
        if (customTpl) {
            message = customTpl
                .replace(/\{title\}/g, title)
                .replace(/\{summary\}/g, cleanSummary)
                .replace(/\{url\}/g, fullBlogUrl)
                .replace(/\{storeName\}/g, storeName)
                .replace(/\{hashtag\}/g, '#thohong #dhtk #tintuc');
        } else {
            message = `📢 BÀI VIẾT MỚI TỪ ${storeName.toUpperCase()}\n\n` +
                      `📌 ${title}\n\n` +
                      `📝 ${cleanSummary}...\n\n` +
                      `👉 Xem chi tiết tại: ${fullBlogUrl}`;
        }

        const results = [];

        // 1. ĐĂNG BÀI LÊN FANPAGE (nếu có Token & Page ID)
        if (fbPageId && fbPageToken) {
            try {
                const feedUrl = `https://graph.facebook.com/v19.0/me/feed`;
                const feedPayload = {
                    message: message,
                    link: fullBlogUrl,
                    published: true,
                    access_token: fbPageToken
                };

                const fbRes = await fetch(feedUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(feedPayload)
                });
                const fbJson = await fbRes.json();

                if (fbJson.id || fbJson.post_id) {
                    const postId = fbJson.id || fbJson.post_id;
                    console.log(`[FACEBOOK FANPAGE SHARE SUCCESS] Post ID: ${postId}`);
                    results.push({ type: 'fanpage', success: true, postId });
                } else {
                    const errMsg = fbJson.error ? `(#${fbJson.error.code}) ${fbJson.error.message}` : 'Lỗi API Facebook';
                    console.error(`[FACEBOOK FANPAGE ERROR]`, fbJson);
                    results.push({ type: 'fanpage', success: false, error: errMsg });
                }
            } catch(errPage) {
                results.push({ type: 'fanpage', success: false, error: errPage.message });
            }
        }

        // 2. ĐĂNG BÀI LÊN GROUP (nếu có Token & Group ID)
        if (fbGroupId && (fbGroupToken || fbPageToken)) {
            try {
                const groupToken = fbGroupToken || fbPageToken;
                const groupUrl = `https://graph.facebook.com/v19.0/${fbGroupId}/feed`;
                const groupPayload = {
                    message: message,
                    link: fullBlogUrl,
                    access_token: groupToken
                };
                const groupRes = await fetch(groupUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(groupPayload)
                });
                const groupJson = await groupRes.json();
                if (groupJson.id) {
                    console.log(`[FACEBOOK GROUP SHARE SUCCESS] Post ID: ${groupJson.id}`);
                    results.push({ type: 'group', success: true, postId: groupJson.id });
                } else {
                    const errMsg = groupJson.error ? `(#${groupJson.error.code}) ${groupJson.error.message}` : 'Lỗi API Facebook';
                    console.error(`[FACEBOOK GROUP ERROR]`, groupJson);
                    results.push({ type: 'group', success: false, error: errMsg });
                }
            } catch(errGroup) {
                results.push({ type: 'group', success: false, error: errGroup.message });
            }
        }

        const successCount = results.filter(r => r.success).length;

        if (results.length === 0) {
            return { error: '❌ Vui lòng nhập Facebook Page ID và Page Access Token ở cài đặt!' };
        }

        if (successCount === 0) {
            const errSummary = results.map(r => `• ${r.type.toUpperCase()}: ${r.error}`).join('\n');
            return { error: `❌ Facebook từ chối bài đăng:\n${errSummary}` };
        }

        if (blogId && successCount > 0) {
            try {
                await db.execute("ALTER TABLE blog_posts ADD COLUMN facebook_shared_at TEXT DEFAULT ''");
            } catch(e) {}
            const nowIso = new Date().toISOString();
            await db.execute({
                sql: "UPDATE blog_posts SET facebook_shared_at = ? WHERE id = ? OR slug = ?",
                args: [nowIso, blogId, blogId]
            });
        }

        return { success: true, results };
    } catch(e) {
        console.error('[FACEBOOK BLOG SHARE ERROR]', e.message);
        return { error: e.message };
    }
}

// --- MAKE.COM / N8N AUTOMATION HELPER & ENDPOINTS ---
function generateSmartHashtags(blogData) {
    let tags = [];
    
    // 1. Sinh Hashtag từ từ khóa bài viết
    if (blogData.keyword) {
        const kwTag = '#' + String(blogData.keyword)
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd').replace(/Đ/g, 'D')
            .replace(/[^a-zA-Z0-9 ]/g, '')
            .trim().split(/\s+/)
            .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
            .join('');
        if (kwTag.length > 2) tags.push(kwTag);
    }

    // 2. Sinh Hashtag từ tiêu đề bài viết
    if (blogData.title) {
        const words = String(blogData.title)
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd').replace(/Đ/g, 'D')
            .replace(/[^a-zA-Z0-9 ]/g, '')
            .trim().split(/\s+/)
            .filter(w => w.length > 2);
        
        if (words.length >= 2) {
            const titleTag = '#' + words.slice(0, 3).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
            if (!tags.includes(titleTag)) tags.push(titleTag);
        }
    }

    // 3. Thêm các Hashtag thương hiệu & ngành hàng chuyên nghiệp
    const defaultTags = ['#ThoHongShop', '#VanPhongPham', '#PhuKienGiaSi', '#DongHangTietKiem'];
    defaultTags.forEach(t => {
        if (!tags.includes(t)) tags.push(t);
    });

    return tags.slice(0, 5).join(' ');
}

const STATIONERY_STOCK_IMAGES = {
    notebook: [
        'https://images.unsplash.com/photo-1544716278-ca5e3f4abd8c?w=800&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1585776245991-cf89dd7fc73a?w=800&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1531346878377-a5be20888e57?w=800&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1517842645767-c639042777db?w=800&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1506784983877-45594efa4cbe?w=800&auto=format&fit=crop&q=80'
    ],
    pen: [
        'https://images.unsplash.com/photo-1583485088034-697b5bc54ccd?w=800&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1585336261026-6757c54e3809?w=800&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=800&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1569683795645-b62e50fbf103?w=800&auto=format&fit=crop&q=80'
    ],
    pencil_case: [
        'https://images.unsplash.com/photo-1595053826286-2e5a37421e59?w=800&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1513542789411-b6a5d4f31634?w=800&auto=format&fit=crop&q=80'
    ],
    stationery_general: [
        'https://images.unsplash.com/photo-1456735190827-d1262f71b8a3?w=800&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1455390582262-044cdead277a?w=800&auto=format&fit=crop&q=80',
        'https://images.unsplash.com/photo-1497633762265-9d179a990aa6?w=800&auto=format&fit=crop&q=80'
    ]
};

function detectStationeryTopic(text) {
    const lower = String(text || '').toLowerCase();
    if (/sổ|bìa da|vở|giấy|tập|journal|planner|notebook/i.test(lower)) return 'notebook';
    if (/bút|chì|viết|dạ|highlight|marker|pen/i.test(lower)) return 'pen';
    if (/bóp|hộp bút|túi đựng|pencil case|pouch/i.test(lower)) return 'pencil_case';
    return 'stationery_general';
}

async function extractBlogImages(blogData) {
    let images = [];
    
    // 1. Trích xuất ảnh bìa của bài viết (Ưu tiên cao nhất)
    let coverImg = blogData.cover_image || blogData.image || '';
    if (coverImg) {
        if (!coverImg.startsWith('http')) coverImg = `https://thohong.top${coverImg.startsWith('/') ? '' : '/'}${coverImg}`;
        images.push(coverImg);
    }

    // 2. Trích xuất tất cả ảnh nằm trong nội dung HTML của bài viết
    if (blogData.content) {
        const imgRegex = /<img[^>]+src=["']([^"']+)["']/gi;
        let match;
        while ((match = imgRegex.exec(blogData.content)) !== null) {
            let src = match[1];
            if (src) {
                if (!src.startsWith('http')) src = `https://thohong.top${src.startsWith('/') ? '' : '/'}${src}`;
                if (!images.includes(src)) images.push(src);
            }
        }
    }

    const postTopic = detectStationeryTopic((blogData.title || '') + ' ' + (blogData.keyword || ''));

    // 3. Nếu ít hơn 4 ảnh, chỉ tìm các sản phẩm trong CSDL KHỚP CHÍNH XÁC chủ đề bài viết
    if (images.length < 4) {
        try {
            let topicKeywords = [];
            if (postTopic === 'notebook') topicKeywords = ['sổ', 'vở', 'tập', 'bìa da'];
            else if (postTopic === 'pen') topicKeywords = ['bút', 'chì', 'viết'];
            else if (postTopic === 'pencil_case') topicKeywords = ['bóp', 'hộp bút', 'túi'];

            if (topicKeywords.length > 0) {
                for (const kw of topicKeywords) {
                    if (images.length >= 4) break;
                    const pRes = await db.execute({
                        sql: "SELECT imageUrl FROM products WHERE imageUrl IS NOT NULL AND imageUrl LIKE 'http%' AND (name LIKE ? OR category LIKE ?) LIMIT 5",
                        args: [`%${kw}%`, `%${kw}%`]
                    });
                    for (const p of (pRes.rows || [])) {
                        if (images.length >= 4) break;
                        if (p.imageUrl && !images.includes(p.imageUrl)) {
                            images.push(p.imageUrl);
                        }
                    }
                }
            }
        } catch(e) {
            console.error('[STRICT BLOG IMAGES MATCH ERROR]', e.message);
        }
    }

    // 4. Nếu vẫn ít hơn 4 ảnh, bổ sung các ảnh kho mẫu cao cấp CHUẨN CÙNG CHỦ ĐỀ (Unsplash HD)
    if (images.length < 4) {
        const stockList = STATIONERY_STOCK_IMAGES[postTopic] || STATIONERY_STOCK_IMAGES['stationery_general'];
        for (const stockUrl of stockList) {
            if (images.length >= 4) break;
            if (!images.includes(stockUrl)) {
                images.push(stockUrl);
            }
        }
    }

    // 5. Nếu vẫn thiếu ảnh, lặp lại các ảnh thực tế của chính bài viết đó (TUYỆT ĐỐI KHÔNG lấy ảnh sai chủ đề)
    const realImgCount = images.length;
    if (realImgCount > 0) {
        while (images.length < 4) {
            images.push(images[images.length % realImgCount]);
        }
    } else {
        const storeDefaultLogo = 'https://thohong.top/app-icon.jpg';
        images = [storeDefaultLogo, storeDefaultLogo, storeDefaultLogo, storeDefaultLogo];
    }

    return images.slice(0, 4);
}

async function triggerMakeWebhook(blogData) {
    try {
        const result = await db.execute("SELECT value FROM settings WHERE key = 'makeWebhookUrl'");
        const webhookUrl = result.rows && result.rows[0] ? result.rows[0].value.trim() : '';
        if (!webhookUrl) return { error: '⚠️ Chưa cấu hình Make.com Webhook URL!' };

        let rawSlug = String(blogData.slug || blogData.id || '').trim();
        rawSlug = rawSlug.replace(/^https?:\/\/[^\/]+/i, '').replace(/^\/?blog\/?/i, '').replace(/^\/+/, '');
        let cleanSlug = rawSlug;
        let finalLink = `https://thohong.top/blog/${rawSlug}`;

        const imagesList = await extractBlogImages(blogData);
        let finalImage = imagesList[0];

        const smartHashtags = generateSmartHashtags(blogData);

        let cleanExcerpt = String(blogData.summary || blogData.excerpt || blogData.title || '')
            .replace(/<[^>]*>/g, '')
            .replace(/[#*>\-\n]/g, ' ')
            .trim();
        if (cleanExcerpt.length > 250) cleanExcerpt = cleanExcerpt.substring(0, 247) + '...';

        const formattedContent = `📣 BÀI VIẾT MỚI TỪ THỎ HỒNG SHOP\n\n📌 ${blogData.title || ''}\n\n📝 ${cleanExcerpt}\n\n👉 Đọc bài viết chi tiết tại đây:\n${finalLink}\n\n${smartHashtags}`;

        const payload = {
            id: blogData.id || blogData.slug || 'sample-post',
            title: blogData.title || 'Mẫu bài viết thử nghiệm từ Thỏ Hồng',
            slug: cleanSlug || 'mau-bai-viet-thu-nghiem',
            excerpt: cleanExcerpt,
            link: finalLink,
            image: finalImage,
            image1: imagesList[0],
            image2: imagesList[1] || imagesList[0],
            image3: imagesList[2] || imagesList[0],
            image4: imagesList[3] || imagesList[0],
            images: imagesList,
            facebook_photos: imagesList.map(url => ({ url: url, type: 'url', photo: url })),
            hashtags: smartHashtags,
            formatted_content: formattedContent,
            created_at: blogData.created_at || new Date().toISOString()
        };

        const res = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // Update make_shared_at timestamp in DB
        try {
            await db.execute("ALTER TABLE blog_posts ADD COLUMN make_shared_at TEXT DEFAULT ''");
        } catch(e) {}

        const nowIso = new Date().toISOString();
        if (blogData.id || blogData.slug) {
            await db.execute({
                sql: "UPDATE blog_posts SET make_shared_at = ? WHERE id = ? OR slug = ?",
                args: [nowIso, blogData.id, blogData.slug]
            });
        }

        return { success: true, message: `🚀 Đã gửi bài viết "${blogData.title}" sang Make.com Webhook thành công!` };
    } catch(e) {
        console.error('[MAKE WEBHOOK ERROR]', e.message);
        return { error: e.message };
    }
}

// Endpoint bắn Make.com thử nghiệm / trực tiếp
app.post('/api/admin/social/make-share-now', authenticateToken, async (req, res) => {
    try {
        const { blogId, webhookUrl } = req.body;
        if (webhookUrl) {
            await db.execute("DELETE FROM settings WHERE key = 'makeWebhookUrl'");
            await db.execute({
                sql: "INSERT INTO settings (key, value) VALUES ('makeWebhookUrl', ?)",
                args: [webhookUrl]
            });
        }

        let blogData = null;

        if (blogId) {
            const blogRes = await db.execute({
                sql: "SELECT * FROM blog_posts WHERE id = ? OR slug = ?",
                args: [blogId, blogId]
            });
            if (blogRes.rows && blogRes.rows.length > 0) {
                blogData = blogRes.rows[0];
            }
        }

        // Nếu không có blogId truyền lên, tự động lấy bài viết mới nhất đã xuất bản trong DB
        if (!blogData) {
            const latestRes = await db.execute("SELECT * FROM blog_posts ORDER BY created_at DESC LIMIT 1");
            if (latestRes.rows && latestRes.rows.length > 0) {
                blogData = latestRes.rows[0];
            }
        }

        // Dự phòng nếu chưa có bài viết nào trong DB
        if (!blogData) {
            blogData = {
                id: 'sample-post-001',
                title: '🎉 Bài viết thử nghiệm phân phối Đa Kênh qua Make.com!',
                slug: 'bai-viet-thu-nghiem-make-automation',
                excerpt: 'Tự động xuất bản bài viết tin tức mới nhất từ hệ thống website Thỏ Hồng lên Facebook, Instagram, Telegram, Zalo OA...',
                image: 'https://thohong.top/media__1784598666512.png'
            };
        }

        const result = await triggerMakeWebhook(blogData);
        if (result.error) return res.status(400).json({ error: result.error });
        res.json(result);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint bắn hàng loạt sang Make.com
app.post('/api/admin/social/make-share-batch', authenticateToken, async (req, res) => {
    try {
        try {
            await db.execute("ALTER TABLE blog_posts ADD COLUMN make_shared_at TEXT DEFAULT ''");
        } catch(e) {}

        const postsRes = await db.execute("SELECT * FROM blog_posts WHERE status = 'published' AND (make_shared_at IS NULL OR make_shared_at = '') LIMIT 20");
        const unsharedPosts = postsRes.rows || [];

        if (unsharedPosts.length === 0) {
            return res.json({ success: true, message: '🎉 Tất cả bài viết đã được phân phối sang Make.com từ trước!' });
        }

        let count = 0;
        for (const post of unsharedPosts) {
            const r = await triggerMakeWebhook(post);
            if (r.success) count++;
        }

        res.json({ success: true, message: `⚡ Đã gửi hàng loạt ${count}/${unsharedPosts.length} bài viết sang Make.com Webhook thành công!` });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// --- ROUTES PHỤC VỤ META FACEBOOK APP REVIEW ---
app.get('/privacy', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Chính Sách Quyền Riêng Tư | Thỏ Hồng & DHTK</title><style>body{font-family:Arial,sans-serif;line-height:1.6;padding:40px;max-width:800px;margin:0 auto;color:#333}h1{color:#1e40af}h2{color:#2563eb}</style></head><body><h1>Chính Sách Quyền Riêng Tư (Privacy Policy)</h1><p>Website và ứng dụng của chúng tôi tôn trọng quyền riêng tư của quý khách hàng. Khi kết nối ứng dụng Facebook, chúng tôi chỉ thu thập thông tin để quản lý việc đăng bài viết tự động từ website lên Fanpage.</p><h2>1. Dữ liệu thu thập</h2><p>Chúng tôi chỉ lưu trữ thông tin ID Trang, Tên Trang và Page Access Token do quý khách cung cấp để phục vụ tính năng chia sẻ bài viết.</p><h2>2. Cam kết bảo mật</h2><p>Dữ liệu được lưu trữ an toàn trong cơ sở dữ liệu và tuyệt đối không chia sẻ cho bất kỳ bên thứ ba nào khác.</p><h2>3. Liên hệ</h2><p>Email: admin@thohong.top | Hotline: 0968.988.636</p></body></html>`);
});

app.get('/terms', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Điều Khoản Dịch Vụ | Thỏ Hồng & DHTK</title><style>body{font-family:Arial,sans-serif;line-height:1.6;padding:40px;max-width:800px;margin:0 auto;color:#333}h1{color:#1e40af}</style></head><body><h1>Điều Khoản Dịch Vụ (Terms of Service)</h1><p>Bằng việc sử dụng tính năng kết nối Facebook trên hệ thống của chúng tôi, bạn đồng ý tuân thủ các quy định đăng tải nội dung phù hợp với tiêu chuẩn cộng đồng của Facebook và pháp luật hiện hành.</p></body></html>`);
});

app.get('/data-deletion', (req, res) => {
    res.send(`<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Hướng Dẫn Xóa Dữ Liệu | Thỏ Hồng & DHTK</title><style>body{font-family:Arial,sans-serif;line-height:1.6;padding:40px;max-width:800px;margin:0 auto;color:#333}h1{color:#1e40af}</style></head><body><h1>Hướng Dẫn Xóa Dữ Liệu Người Dùng (Data Deletion Instructions)</h1><p>Nếu bạn muốn xóa toàn bộ dữ liệu kết nối ứng dụng Facebook khỏi hệ thống của chúng tôi:</p><ol><li>Đăng nhập vào Admin CP của bạn.</li><li>Vào mục Cấu hình Facebook ➔ Nhấp "Xóa cài đặt Facebook".</li><li>Hoặc gửi yêu cầu xóa dữ liệu về Email: admin@thohong.top. Chúng tôi sẽ xóa toàn bộ Token trong vòng 24 giờ.</li></ol></body></html>`);
});

// Meta Data Deletion Callback Endpoint
app.post('/api/facebook/data-deletion-callback', (req, res) => {
    const confirmCode = 'FB_DEL_' + Math.floor(Math.random() * 1000000);
    res.json({
        url: `https://thohong.top/data-deletion?code=${confirmCode}`,
        confirmation_code: confirmCode
    });
});

// RSS FEED ROUTE FOR MAKE.COM, N8N & AUTOMATION PLATFORMS
app.get('/rss.xml', async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM blog_posts WHERE status = 'published' ORDER BY created_at DESC LIMIT 50");
        const posts = result.rows || [];
        
        let rssXml = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
    <title>Thỏ Hồng - Phụ Kiện &amp; Quà Tặng</title>
    <link>https://thohong.top</link>
    <description>Kênh tin tức, khuyến mãi &amp; hướng dẫn mua sắm phụ kiện văn phòng phẩm Thỏ Hồng</description>
    <language>vi</language>
    <atom:link href="https://thohong.top/rss.xml" rel="self" type="application/rss+xml" />`;

        posts.forEach(p => {
            const postUrl = `https://thohong.top/blog/${p.slug || p.id}`;
            const pubDate = p.created_at ? new Date(p.created_at).toUTCString() : new Date().toUTCString();
            const cleanTitle = (p.title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const cleanDesc = (p.excerpt || p.title || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

            rssXml += `
    <item>
        <title>${cleanTitle}</title>
        <link>${postUrl}</link>
        <guid isPermaLink="true">${postUrl}</guid>
        <pubDate>${pubDate}</pubDate>
        <description>${cleanDesc}</description>
    </item>`;
        });

        rssXml += `
</channel>
</rss>`;

        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.send(rssXml);
    } catch (e) {
        res.status(500).send('Error generating RSS feed');
    }
});

// --- ROUTES ---

// 1. ADMIN LOGIN
const loginAttempts = {};
app.post('/api/login', (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();
    req.clientIp = ip;
    req.requestTime = now;

    if (loginAttempts[ip]) {
        const attempt = loginAttempts[ip];
        if (attempt.blockUntil && now < attempt.blockUntil) {
            const timeLeft = Math.ceil((attempt.blockUntil - now) / 60000);
            return res.status(429).json({ error: `Đăng nhập thất bại quá nhiều lần. Vui lòng thử lại sau ${timeLeft} phút.` });
        }
        if (attempt.blockUntil && now >= attempt.blockUntil) {
            delete loginAttempts[ip];
        }
    }
    next();
}, async (req, res) => {
    const { username, passwordHash } = req.body;
    if (!username || !passwordHash) {
        return res.status(400).json({ error: 'Username and passwordHash are required' });
    }

    const ip = req.clientIp;
    const now = req.requestTime;

    try {
        const result = await db.execute({
            sql: 'SELECT * FROM admin_creds WHERE username = ?',
            args: [username]
        });
        const admin = result.rows[0];
        if (admin && admin.password_hash === passwordHash) {
            if (loginAttempts[ip]) delete loginAttempts[ip];
            const token = jwt.sign({ username: admin.username }, JWT_SECRET, { expiresIn: '7d' });
            return res.json({ success: true, token, username: admin.username });
        }

        // Tăng số lần thử sai
        if (!loginAttempts[ip]) {
            loginAttempts[ip] = { count: 1, blockUntil: null };
        } else {
            loginAttempts[ip].count += 1;
            if (loginAttempts[ip].count >= 5) {
                loginAttempts[ip].blockUntil = now + 5 * 60 * 1000; // khóa 5 phút
                return res.status(429).json({ error: 'Đăng nhập sai quá 5 lần. Bạn bị tạm khóa đăng nhập trong 5 phút.' });
            }
        }

        return res.status(400).json({ error: 'Incorrect username or password' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. CHANGE PASSWORD (ADMIN ONLY)
app.post('/api/change-password', authenticateToken, async (req, res) => {
    const { newUsername, oldPasswordHash, newPasswordHash } = req.body;
    if (!newUsername || !oldPasswordHash || !newPasswordHash) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    try {
        const username = req.user.username;
        const result = await db.execute({
            sql: 'SELECT * FROM admin_creds WHERE username = ?',
            args: [username]
        });
        const admin = result.rows[0];

        if (admin.password_hash !== oldPasswordHash) {
            return res.status(400).json({ error: 'Incorrect current password' });
        }

        await db.execute({
            sql: 'DELETE FROM admin_creds WHERE username = ?',
            args: [username]
        });
        await db.execute({
            sql: 'INSERT INTO admin_creds (username, password_hash) VALUES (?, ?)',
            args: [newUsername, newPasswordHash]
        });

        const token = jwt.sign({ username: newUsername }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ success: true, token, username: newUsername });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. GET SETTINGS (PUBLIC ONLY - NO SENSITIVE DATA)
app.get('/api/settings', async (req, res) => {
    try {
        const result = await db.execute('SELECT * FROM settings');
        const rows = result.rows;
        const settings = {};
        const publicKeys = ['bannerTitle', 'bannerSubtitle', 'logoText', 'metaTitle', 'metaDescription', 'storeName', 'contact_hotline', 'contact_zalo', 'hideOutOfStock', 'customHeaderCode', 'ogImage', 'seoCatTitleTpl', 'seoCatDescTpl', 'seoProdTitleTpl', 'seoProdDescTpl', 'makeWebhookUrl', 'autoMakeShare'];
        rows.forEach(r => {
            if (publicKeys.includes(r.key)) {
                // Parse boolean string 'true'/'false' back to boolean type if it's hideOutOfStock
                if (r.key === 'hideOutOfStock') {
                    settings[r.key] = (r.value === 'true');
                } else {
                    settings[r.key] = r.value;
                }
            }
        });
        res.json(settings);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3.1 GET SETTINGS PRIVATE (ADMIN ONLY)
app.get('/api/settings/private', authenticateToken, async (req, res) => {
    try {
        const result = await db.execute('SELECT * FROM settings');
        const rows = result.rows;
        const settings = {};
        rows.forEach(r => {
            settings[r.key] = r.value;
        });
        res.json(settings);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. UPDATE SETTINGS (ADMIN ONLY)
app.post('/api/settings', authenticateToken, async (req, res) => {
    const newSettings = req.body;
    try {
        for (const [key, value] of Object.entries(newSettings)) {
            if (value !== undefined && value !== null && value !== 'undefined') {
                await db.execute({
                    sql: 'DELETE FROM settings WHERE key = ?',
                    args: [key]
                });
                await db.execute({
                    sql: 'INSERT INTO settings (key, value) VALUES (?, ?)',
                    args: [key, String(value)]
                });
            }
        }
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

const toAsciiSlug = (str) => {
    if (!str) return '';
    return str.toLowerCase()
        .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
        .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
        .replace(/[ìíịỉĩ]/g, 'i')
        .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
        .replace(/[ùúụủũưừứựửữ]/g, 'u')
        .replace(/[ỳýỵỷỹ]/g, 'y')
        .replace(/đ/g, 'd')
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
};

// --- CATEGORY APIS ---
app.get('/api/categories', async (req, res) => {
    try {
        const result = await db.execute('SELECT * FROM categories ORDER BY name ASC');
        res.json(result.rows || []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/categories', authenticateToken, async (req, res) => {
    try {
        const { id, name } = req.body;
        if (!name) return res.status(400).json({ error: 'Thiếu tên danh mục' });
        
        const slug = toAsciiSlug(name);
        const catId = id || 'CAT' + Date.now();
        
        await db.execute({
            sql: "INSERT OR REPLACE INTO categories (id, name, slug) VALUES (?, ?, ?)",
            args: [catId, name, slug]
        });
        res.json({ success: true, id: catId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete('/api/categories/:id', authenticateToken, async (req, res) => {
    try {
        await db.execute({
            sql: 'DELETE FROM categories WHERE id = ?',
            args: [req.params.id]
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. GET PRODUCTS (NO BACKGROUND AUTO-SYNC CHECK ON SERVERLESS TO PREVENT TIMEOUT)
app.get('/api/products', async (req, res) => {
    try {
        const result = await db.execute('SELECT * FROM products');
        const rows = result.rows;
        const products = rows.map(r => {
            let details = {};
            try {
                if (r.details) {
                    const parsed = JSON.parse(r.details);
                    if (typeof parsed === 'object') {
                        details = parsed;
                    } else {
                        details.description = r.details;
                    }
                }
            } catch(e) {
                details.description = r.details;
            }
            return {
                id: r.id,
                name: r.name,
                sku: r.sku,
                price: r.price,
                costPrice: r.costPrice,
                imageUrl: r.imageUrl,
                category: r.category,
                quantity: r.quantity,
                status: r.status,
                discountGroup: r.discountGroup,
                images: details.images || [],
                pricingTiers: details.pricingTiers || [],
                options: details.options || [],
                variants: details.variants || [],
                description: details.description || '',
                weight: details.weight || '0'
            };
        });
        
        res.json(products);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 6. SAVE PRODUCTS (ADMIN ONLY - ADD/UPDATE)
app.post('/api/products', authenticateToken, async (req, res) => {
    const p = req.body;
    if (!p.id || !p.name) return res.status(400).json({ error: 'Missing product ID or Name' });

    try {
        const detailsJson = JSON.stringify({
            images: p.images || [],
            pricingTiers: p.pricingTiers || [],
            options: p.options || [],
            variants: p.variants || [],
            description: p.description || ''
        });
        await db.execute({
            sql: `
                INSERT OR REPLACE INTO products 
                (id, name, sku, price, costPrice, imageUrl, category, quantity, status, discountGroup, details) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            args: [
                String(p.id), p.name, p.sku || '', parseInt(p.price) || 0, parseInt(p.costPrice) || 0,
                p.imageUrl || (p.images && p.images[0]) || '', p.category || '', parseInt(p.quantity) || 0,
                p.status || 'active', p.discountGroup || '', detailsJson
            ]
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7. DELETE PRODUCT (ADMIN ONLY)
app.delete('/api/products/:id', authenticateToken, async (req, res) => {
    try {
        await db.execute({
            sql: 'DELETE FROM products WHERE id = ?',
            args: [req.params.id]
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 8. IMPORT PRODUCTS FROM EXCEL DATA (ADMIN ONLY)
app.post('/api/products/import', authenticateToken, async (req, res) => {
    const { products, clearFirst } = req.body;
    if (!Array.isArray(products)) return res.status(400).json({ error: 'Invalid products array' });

    try {
        if (clearFirst !== false) {
            await db.execute('DELETE FROM products');
        }

        const CHUNK_SIZE = 500;
        for (let i = 0; i < products.length; i += CHUNK_SIZE) {
            const chunk = products.slice(i, i + CHUNK_SIZE);
            const stmts = chunk.map(p => {
                const detailsJson = JSON.stringify({
                    images: p.images || [],
                    pricingTiers: p.pricingTiers || [],
                    options: p.options || [],
                    variants: p.variants || [],
                    description: p.description || '',
                    weight: p.weight || 0
                });
                return {
                    sql: `INSERT OR REPLACE INTO products (id, name, sku, price, costPrice, imageUrl, category, quantity, status, discountGroup, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    args: [
                        String(p.id), String(p.name || ''), String(p.sku || ''), parseInt(p.price) || 0, parseInt(p.costPrice) || 0,
                        String(p.imageUrl || (p.images && p.images[0]) || ''), String(p.category || ''), parseInt(p.quantity) || 0,
                        String(p.status || 'active'), String(p.discountGroup || ''), detailsJson
                    ]
                };
            });
            
            const batchResult = await db.executeBatch(stmts);
            // Check for errors in the batch result
            if (batchResult.results) {
                for (let r of batchResult.results) {
                    if (r.type === 'error') {
                        throw new Error("Turso SQL Error: " + r.error.message);
                    }
                }
            }
        }
        res.json({ success: true, count: products.length });
    } catch (e) {
        console.error('[IMPORT ERROR]', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 9. ANALYTICS (TRACKING)
app.post('/api/track', async (req, res) => {
    try {
        let { url, referrer, product_id } = req.body || {};
        url = (url || '').substring(0, 500);
        referrer = (referrer || '').substring(0, 500);
        product_id = (product_id || '').substring(0, 100);

        const vnTime = new Date(new Date().getTime() + (7 * 60 * 60 * 1000));
        const dateStr = vnTime.toISOString().split('T')[0];

        await db.execute({
            sql: `INSERT INTO daily_stats (date, referrer, url, product_id, view_count) 
                  VALUES (?, ?, ?, ?, 1) 
                  ON CONFLICT(date, referrer, url, product_id) 
                  DO UPDATE SET view_count = view_count + 1`,
            args: [dateStr, referrer, url, product_id]
        });

        res.json({ success: true });
    } catch (e) {
        console.error('[TRACKING ERROR]', e);
        res.status(500).json({ error: e.message || 'Internal server error' });
    }
});

app.get('/api/admin/analytics', authenticateToken, async (req, res) => {
    try {
        let { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
            const vnNow = new Date(new Date().getTime() + (7 * 60 * 60 * 1000));
            const yyyy = vnNow.getUTCFullYear();
            const mm = String(vnNow.getUTCMonth() + 1).padStart(2, '0');
            const dd = String(vnNow.getUTCDate()).padStart(2, '0');
            
            endDate = `${yyyy}-${mm}-${dd}`;
            startDate = `${yyyy}-${mm}-01`;
        }

        const refResult = await db.execute({
            sql: `SELECT referrer, SUM(view_count) as total_views FROM daily_stats WHERE date >= ? AND date <= ? GROUP BY referrer ORDER BY total_views DESC`,
            args: [startDate, endDate]
        });

        const prodResult = await db.execute({
            sql: `SELECT product_id, SUM(view_count) as total_views FROM daily_stats WHERE date >= ? AND date <= ? AND product_id != '' GROUP BY product_id ORDER BY total_views DESC LIMIT 10`,
            args: [startDate, endDate]
        });

        const totalResult = await db.execute({
            sql: `SELECT SUM(view_count) as total FROM daily_stats WHERE date >= ? AND date <= ?`,
            args: [startDate, endDate]
        });
        const totalViews = (totalResult.rows && totalResult.rows[0] && totalResult.rows[0].total) ? Number(totalResult.rows[0].total) : 0;

        const d1 = new Date(startDate);
        const d2 = new Date(endDate);
        const diffDays = Math.max(1, Math.ceil(Math.abs(d2 - d1) / (1000 * 60 * 60 * 24)) + 1);

        const prevEnd = new Date(d1.getTime() - (1 * 24 * 60 * 60 * 1000));
        const prevStart = new Date(prevEnd.getTime() - ((diffDays - 1) * 24 * 60 * 60 * 1000));
        const prevStartStr = prevStart.toISOString().split('T')[0];
        const prevEndStr = prevEnd.toISOString().split('T')[0];

        const prevResult = await db.execute({
            sql: `SELECT SUM(view_count) as total FROM daily_stats WHERE date >= ? AND date <= ?`,
            args: [prevStartStr, prevEndStr]
        });
        const prevTotalViews = (prevResult.rows && prevResult.rows[0] && prevResult.rows[0].total) ? Number(prevResult.rows[0].total) : 0;

        res.json({
            success: true,
            currentPeriod: { start: startDate, end: endDate, totalViews },
            previousPeriod: { start: prevStartStr, end: prevEndStr, totalViews: prevTotalViews },
            sources: refResult.rows || [],
            topProducts: prodResult.rows || []
        });
    } catch (e) {
        console.error('[ANALYTICS ERROR]', e);
        res.status(500).json({ error: e.message || 'Internal server error' });
    }
});

app.get('/api/debug-count', async (req, res) => {
    try {
        const result = await db.execute('SELECT COUNT(*) as c FROM products');
        res.json({ count: result.rows[0].c });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 9. SUBMIT ORDER & TELEGRAM NOTIFICATION (PUBLIC WITH RATE LIMIT & VALIDATION)
const orderRateLimit = {};
app.post('/api/orders', (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const now = Date.now();
    if (!orderRateLimit[ip]) orderRateLimit[ip] = [];
    orderRateLimit[ip] = orderRateLimit[ip].filter(t => now - t < 60000);
    if (orderRateLimit[ip].length >= 10) {
        return res.status(429).json({ error: 'Bạn gửi đơn quá nhiều. Vui lòng thử lại sau 1 phút.' });
    }
    orderRateLimit[ip].push(now);
    next();
}, async (req, res) => {
    const { customerInfo, items } = req.body;
    if (!customerInfo || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Missing order details' });
    }

    // Input Validation
    const name = (customerInfo.name || '').trim();
    const phone = (customerInfo.phone || '').trim();
    const address = (customerInfo.address || '').trim();
    if (!name) return res.status(400).json({ error: 'Tên khách hàng không được để trống' });
    if (!address) return res.status(400).json({ error: 'Địa chỉ giao hàng không được để trống' });
    if (!/^\d{9,11}$/.test(phone)) {
        return res.status(400).json({ error: 'Số điện thoại không hợp lệ (phải từ 9-11 chữ số)' });
    }
    if (items.length > 50) {
        return res.status(400).json({ error: 'Đơn hàng quá dài (tối đa 50 sản phẩm)' });
    }
    for (const item of items) {
        if (!item.id || isNaN(item.qty) || item.qty <= 0 || item.qty > 10000) {
            return res.status(400).json({ error: 'Thông tin sản phẩm hoặc số lượng không hợp lệ' });
        }
    }

    try {
        const result = await db.execute('SELECT * FROM products');
        const dbProducts = result.rows;
        const productMap = {};
        dbProducts.forEach(p => productMap[p.id] = p);

        const groupQuantities = {};
        items.forEach(item => {
            const originalProduct = productMap[item.id];
            if (originalProduct && originalProduct.discountGroup) {
                const group = originalProduct.discountGroup;
                groupQuantities[group] = (groupQuantities[group] || 0) + item.qty;
            }
        });

        let totalAmount = 0;
        let originalAmount = 0;
        const processedItems = [];

        items.forEach(item => {
            const originalProduct = productMap[item.id];
            if (!originalProduct) return;

            let details = {};
            try { details = JSON.parse(originalProduct.details || '{}'); } catch(e) {}

            const group = originalProduct.discountGroup;
            const totalGroupQty = groupQuantities[group] || item.qty;

            // Tính Tier áp dụng
            let appliedTierId = null;
            let baseTierId = null;
            if (details.pricingTiers && details.pricingTiers.length > 0) {
                baseTierId = details.pricingTiers[0].id;
                let appliedTier = details.pricingTiers[0];
                for (let i = 0; i < details.pricingTiers.length; i++) {
                    if (totalGroupQty >= details.pricingTiers[i].condition) appliedTier = details.pricingTiers[i];
                }
                appliedTierId = appliedTier.id;
            }

            let posProductId = null;
            let posVariantId = null;
            let matchedVar = null;

            let posRetailPrice = null;
            if (details.variants && details.variants.length > 0) {
                matchedVar = details.variants.find(v => String(v.id) === String(item.variantId) || (v.sku && item.sku && (v.sku || '').trim().toUpperCase() === (item.sku || '').trim().toUpperCase()));
                if (!matchedVar && details.variants.length === 1) {
                    matchedVar = details.variants[0];
                }
                if (matchedVar) {
                    posProductId = matchedVar.pos_product_id;
                    posVariantId = matchedVar.pos_variant_id;
                    posRetailPrice = matchedVar.pos_retail_price;
                }
            }
            if (!posProductId) {
                posProductId = details.pos_product_id;
                posVariantId = details.pos_variant_id;
            }
            if (posRetailPrice == null) {
                posRetailPrice = details.pos_retail_price || (details.variants && details.variants[0] ? details.variants[0].pos_retail_price : null);
            }

            // Lấy giá từ biến thể
            let finalUnitPrice = 0;
            let baseOriginalPrice = 0;
            
            if (matchedVar && matchedVar.prices) {
                finalUnitPrice = Number(matchedVar.prices[appliedTierId] || matchedVar.prices[baseTierId] || 0);
                baseOriginalPrice = Number(matchedVar.prices[baseTierId] || 0);
            } else {
                finalUnitPrice = Number(originalProduct.price || 0);
                baseOriginalPrice = Number(originalProduct.price || 0);
            }

            const itemTotal = finalUnitPrice * item.qty;
            const itemOriginalTotal = baseOriginalPrice * item.qty;

            totalAmount += itemTotal;
            originalAmount += itemOriginalTotal;

            processedItems.push({
                name: originalProduct.name,
                sku: matchedVar ? matchedVar.sku : originalProduct.sku,
                qty: item.qty,
                originalPrice: baseOriginalPrice,
                finalPrice: finalUnitPrice,
                total: itemTotal,
                pos_product_id: posProductId,
                pos_variant_id: posVariantId,
                pos_retail_price: posRetailPrice
            });
        });

        const tgTokenResult = await db.execute("SELECT value FROM settings WHERE key = 'telegramToken'");
        const tgChatIdResult = await db.execute("SELECT value FROM settings WHERE key = 'telegramChatId'");
        const storeNameResult = await db.execute("SELECT value FROM settings WHERE key = 'storeName'");

        const tgToken = tgTokenResult.rows[0]?.value || '';
        const tgChatId = tgChatIdResult.rows[0]?.value || '';
        const storeName = storeNameResult.rows[0]?.value || 'ĐHTK Store';

        const formatMoney = (amount) => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);

        // Sanitize user-input truoc khi dua vao Telegram message (chong HTML injection)
        const sanitize = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

        let itemsText = '';
        processedItems.forEach((item, idx) => {
            itemsText += `${idx + 1}. <b>${sanitize(item.name)}</b> (SKU: <code>${sanitize(item.sku || 'N/A')}</code>)\n`;
            itemsText += `   SL: <b>${item.qty}</b> x Đơn giá: <s>${formatMoney(item.originalPrice)}</s> -> <b>${formatMoney(item.finalPrice)}</b> (Chiết khấu sỉ)\n`;
            itemsText += `   Thành tiền: <b>${formatMoney(item.total)}</b>\n\n`;
        });

        const totalDiscount = originalAmount - totalAmount;

        const messageText = `🛒 <b>ĐƠN HÀNG MỚI TỪ ${sanitize(storeName).toUpperCase()}</b>\n` +
            `📅 Thời gian: ${new Date().toLocaleString('vi-VN')}\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n\n` +
            `👤 <b>Khách hàng:</b> ${sanitize(customerInfo.name)}\n` +
            `📞 <b>Điện thoại:</b> <code>${sanitize(customerInfo.phone)}</code>\n` +
            `📍 <b>Địa chỉ:</b> ${sanitize(customerInfo.address)}\n` +
            (customerInfo.note ? `📝 <b>Ghi chú:</b> ${sanitize(customerInfo.note)}\n` : '') +
            `\n📦 <b>Danh sách sản phẩm:</b>\n` +
            `${itemsText}` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `💰 <b>Tổng giá trị gốc:</b> ${formatMoney(originalAmount)}\n` +
            `🎁 <b>Tổng chiết khấu:</b> -${formatMoney(totalDiscount)}\n` +
            `💵 <b>Tổng thanh toán:</b> <b>${formatMoney(totalAmount)}</b>\n\n` +
            `✍️ <i>Đơn hàng tự động cộng gộp chiết khấu theo nhóm sản phẩm.</i>`;


        let telegramSent = false;
        if (tgToken && tgChatId) {
            try {
                await sendTelegramMessage(tgToken, tgChatId, messageText);
                telegramSent = true;
            } catch (e) {
                console.error('[Order Telegram Notify Fail]', e.message);
            }
        }

        let posSuccess = false;
        let posOrderId = null;
        let posErrorMsg = null;
        try {
            // Đẩy đơn hàng sang Pancake POS đồng bộ
            const posResult = await pushOrderToPancake(customerInfo, processedItems);
            if (posResult && posResult.success) {
                posSuccess = true;
                posOrderId = posResult.data ? (posResult.data.id || posResult.data.system_id) : null;
            } else {
                posErrorMsg = posResult ? (posResult.message || posResult.error || JSON.stringify(posResult)) : "Lỗi không xác định";
            }
        } catch(err) {
            console.error('[PANCAKE SYNC ERROR]', err);
            posErrorMsg = err.message;
        }

        const finalOrderId = Date.now();

        res.json({
            success: true,
            orderId: finalOrderId,
            posSuccess: posSuccess,
            posOrderId: posOrderId,
            posErrorMsg: posErrorMsg,
            totalAmount,
            totalDiscount,
            telegramSent
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- HELPER FUNCTION FOR PANCAKE POS ORDER SYNC ---
async function pushOrderToPancake(customerInfo, processedItems) {
    try {
        const rowsResult = await db.execute("SELECT * FROM settings WHERE key IN ('pos_api_key', 'pos_shop_id', 'pos_warehouse_id')");
        const settings = {};
        rowsResult.rows.forEach(r => settings[r.key] = r.value);

        const apiKey = settings.pos_api_key || process.env.PANCAKE_API_KEY;
        const shopId = settings.pos_shop_id || process.env.PANCAKE_SHOP_ID;
        // Fallback ID Kho Thỏ Hồng / ĐHTK mặc định nếu chưa cài đặt
        const warehouseId = settings.pos_warehouse_id || process.env.PANCAKE_WAREHOUSE_ID || 'dac2f936-28a2-4ac0-b6ba-c3dba5ddf4b1';

        if (!apiKey || !shopId) {
            console.log('[PANCAKE ORDER SYNC] Bỏ qua đẩy đơn vì chưa cài đặt pos_api_key hoặc pos_shop_id');
            return { success: false, message: 'Chưa cấu hình pos_api_key hoặc pos_shop_id trong hệ thống POS' };
        }

        // Realtime POS Fetch: Nếu có sản phẩm chưa nối kho POS, tự động tìm trên POS theo SKU và gán ID ngay lập tức
        for (let item of processedItems) {
            if (!item.pos_product_id || !item.pos_variant_id) {
                try {
                    const searchSku = (item.sku || '').trim();
                    if (searchSku) {
                        console.log(`[REALTIME POS FETCH] Đang tìm kiếm SKU "${searchSku}" trực tiếp trên POS...`);
                        const searchUrl = `https://pos.pages.fm/api/v1/shops/${shopId}/products?api_key=${apiKey}&search=${encodeURIComponent(searchSku)}`;
                        const sRes = await fetch(searchUrl);
                        const sData = await sRes.json();
                        if (sData && sData.data && sData.data.length > 0) {
                            for (let posP of sData.data) {
                                if (posP.variations && posP.variations.length > 0) {
                                    const matchedV = posP.variations.find(v => (v.sku || '').toUpperCase() === searchSku.toUpperCase());
                                    if (matchedV) {
                                        item.pos_product_id = posP.id;
                                        item.pos_variant_id = matchedV.id;
                                        if (matchedV.retail_price) item.pos_retail_price = matchedV.retail_price;
                                        console.log(`[REALTIME POS FETCH SUCCESS] Đã tìm thấy SKU ${searchSku} -> pos_product_id: ${posP.id}, pos_variant_id: ${matchedV.id}`);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                } catch(e) {
                    console.error('[REALTIME POS FETCH ERROR]:', e.message);
                }
            }
        }

        let posOriginalAmount = 0;
        let finalPayAmount = 0;
        let missingPosItems = [];

        const items = processedItems.map(item => {
            const line = {
                quantity: item.qty
            };
            if (item.pos_product_id) line.product_id = item.pos_product_id;
            if (item.pos_variant_id) line.variation_id = item.pos_variant_id;
            
            if (!item.pos_product_id || !item.pos_variant_id) {
                missingPosItems.push(item.sku || item.name);
            }

            let posPrice = (item.pos_retail_price != null && item.pos_retail_price > 0) 
                ? item.pos_retail_price 
                : item.originalPrice;
            posOriginalAmount += posPrice * item.qty;
            finalPayAmount += item.finalPrice * item.qty;

            return line;
        });

        const orderPayload = {
            order: {
                order_sources: process.env.PANCAKE_ORDER_SOURCE || 'ĐHTK Store',
                warehouse_id: warehouseId,
                bill_full_name: customerInfo.name,
                bill_phone_number: customerInfo.phone,
                shipping_address: {
                    full_name: customerInfo.name,
                    phone_number: customerInfo.phone,
                    full_address: customerInfo.address,
                    address: customerInfo.address
                },
                note: customerInfo.note || '',
                items: items,
                discount: posOriginalAmount - finalPayAmount
            }
        };

        console.log('[PANCAKE PRICE DEBUG] posOriginalAmount:', posOriginalAmount, '| finalPayAmount:', finalPayAmount, '| discount:', posOriginalAmount - finalPayAmount);
        if (missingPosItems.length > 0) {
            console.warn(`[PANCAKE WARN] Các SKU chưa được nối kho POS: ${missingPosItems.join(', ')}. Hãy mở Admin Panel -> bấm 'Đồng bộ Tồn Kho POS'.`);
        }

        let url = `https://pos.pages.fm/api/v1/shops/${shopId}/orders?api_key=${apiKey}&warehouse_id=${warehouseId}`;
        console.log(`[PANCAKE ORDER SYNC] Đang đẩy đơn hàng của ${customerInfo.name} sang Pancake POS Shop ${shopId}... URL: ${url}`);

        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderPayload)
        });

        const result = await resp.json();
        console.log('[PANCAKE ORDER SYNC RESULT]:', JSON.stringify(result));
        return result;
    } catch (err) {
        console.error('[PANCAKE ORDER SYNC ERROR]:', err.message);
        return { success: false, error: err.message };
    }
}

// --- HELPER FUNCTION FOR POS SYNC (WITH CONNECTION TIMEOUT) ---
async function performPosSync(posCredentials) {
    console.log(`[POS SYNC] Bắt đầu kết nối Pancake POS Shop ${posCredentials.shopId}...`);
    
    let allPosProducts = [];
    let page = 1;
    let totalPages = 1;

    const getParams = (pg) => {
        const params = new URLSearchParams({
            api_key: posCredentials.apiKey,
            page_number: pg,
            page_size: 50
        });
        if (posCredentials.warehouseId) {
            params.append('warehouse_id', posCredentials.warehouseId);
        }
        return params.toString();
    };

    const fetchWithTimeout = async (url, options = {}, timeout = 8000) => {
        const controller = new AbortController();
        const id = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(id);
            return response;
        } catch (e) {
            clearTimeout(id);
            if (e.name === 'AbortError') {
                throw new Error('Kết nối sang Pancake POS bị quá thời gian (Timeout 8s)');
            }
            throw e;
        }
    };

    // Fetch page 1
    const firstUrl = `https://pos.pages.fm/api/v1/shops/${posCredentials.shopId}/products?${getParams(1)}`;
    const firstResp = await fetchWithTimeout(firstUrl);
    if (!firstResp.ok) throw new Error(`HTTP ${firstResp.status} khi gọi API Pancake`);
    
    const firstResult = await firstResp.json();
    if (firstResult.success === false) throw new Error(firstResult.message || 'API Pancake trả về lỗi');

    totalPages = firstResult.total_pages || 1;
    const pageProducts = firstResult.products || firstResult.data || [];
    allPosProducts = allPosProducts.concat(pageProducts);

    console.log(`[POS SYNC] Đã tải trang 1/${totalPages}. Lấy được ${pageProducts.length} sản phẩm.`);

    // Fetch remaining pages in parallel using Promise.all (Tối ưu tốc độ gấp 10 lần, tránh timeout)
    if (totalPages > 1) {
        const promises = [];
        for (let pg = 2; pg <= totalPages; pg++) {
            const url = `https://pos.pages.fm/api/v1/shops/${posCredentials.shopId}/products?${getParams(pg)}`;
            promises.push(
                fetchWithTimeout(url).then(async resp => {
                    if (resp.ok) {
                        const result = await resp.json();
                        return result.products || result.data || [];
                    }
                    return [];
                }).catch(pgErr => {
                    console.error(`[POS SYNC] Lỗi tải trang ${pg}:`, pgErr.message);
                    return [];
                })
            );
        }
        const results = await Promise.all(promises);
        results.forEach(pageData => {
            allPosProducts = allPosProducts.concat(pageData);
        });
    }

    console.log(`[POS SYNC] Tổng cộng lấy được ${allPosProducts.length} sản phẩm từ Pancake POS. Bắt đầu đối soát...`);

    const skuStockMap = {};
    
    const getStock = (obj) => {
        if (obj.inventories && Array.isArray(obj.inventories) && obj.inventories.length > 0) {
            if (posCredentials.warehouseId) {
                const whInv = obj.inventories.find(inv => 
                    String(inv.warehouse_id) === String(posCredentials.warehouseId) || String(inv.id) === String(posCredentials.warehouseId)
                );
                if (whInv) {
                    return whInv.available_quantity ?? whInv.available ?? whInv.quantity ?? 0;
                }
            }
            return obj.inventories.reduce((sum, inv) => 
                sum + (inv.available_quantity ?? inv.available ?? inv.quantity ?? 0), 0
            );
        }
        if (obj.available_quantity != null) return obj.available_quantity;
        if (obj.available != null) return obj.available;
        if (obj.remain_quantity != null) return obj.remain_quantity;
        if (obj.quantity != null) return obj.quantity;
        if (obj.stock != null) return obj.stock;
        return 0;
    };

    allPosProducts.forEach(posProduct => {
        const variations = posProduct.variations || posProduct.product_variations || [];
        const pId = posProduct.id || posProduct.product_id;
        if (variations.length === 0) {
            const code = posProduct.code || posProduct.sku || posProduct.id;
            if (code) {
                skuStockMap[String(code).trim().toUpperCase()] = {
                    stock: getStock(posProduct),
                    pos_product_id: pId,
                    pos_variant_id: null,
                    pos_retail_price: posProduct.retail_price || 0
                };
            }
        } else {
            variations.forEach(v => {
                const sku = v.code || v.sku || v.barcode;
                if (sku) {
                    skuStockMap[String(sku).trim().toUpperCase()] = {
                        stock: getStock(v),
                        pos_product_id: pId || v.product_id,
                        pos_variant_id: v.id || v.variation_id,
                        pos_retail_price: v.retail_price || posProduct.retail_price || 0
                    };
                }
            });
        }
    });

    const resultProducts = await db.execute('SELECT * FROM products');
    const dbProducts = resultProducts.rows;
    let updateCount = 0;
    const matchedProducts = [];
    const unmatchedProducts = [];

    // Collect all updates, then batch execute in 1 round-trip to DB
    const batchStmts = [];

    for (const localProduct of dbProducts) {
        let details = {};
        try {
            if (localProduct.details) {
                details = JSON.parse(localProduct.details);
            }
        } catch(e) {}

        let variants = details.variants || [];
        let isUpdated = false;
        let productQuantitySum = 0;

        if (variants.length === 0) {
            const parentSku = (localProduct.sku || '').trim().toUpperCase();
            if (parentSku && skuStockMap.hasOwnProperty(parentSku)) {
                const posData = skuStockMap[parentSku];
                const newStock = posData.stock;
                const oldStock = localProduct.quantity || 0;
                if (oldStock !== newStock) {
                    updateCount++;
                }
                productQuantitySum = newStock;
                details.pos_product_id = posData.pos_product_id;
                details.pos_variant_id = posData.pos_variant_id;
                details.pos_retail_price = posData.pos_retail_price;
                isUpdated = true;

                matchedProducts.push({
                    sku: localProduct.sku,
                    name: localProduct.name,
                    oldQty: oldStock,
                    qty: newStock,
                    changed: oldStock !== newStock
                });
            } else {
                productQuantitySum = localProduct.quantity || 0;
                if (parentSku) {
                    unmatchedProducts.push({
                        sku: localProduct.sku,
                        name: localProduct.name,
                        reason: 'Không tìm thấy SKU này trên Pancake POS'
                    });
                }
            }
        } else {
            variants.forEach(v => {
                const skuKey = (v.sku || '').trim().toUpperCase();
                if (skuKey && skuStockMap.hasOwnProperty(skuKey)) {
                    const posData = skuStockMap[skuKey];
                    const newStock = posData.stock;
                    const oldStock = v.stock || 0;
                    if (oldStock !== newStock) {
                        updateCount++;
                    }
                    v.stock = newStock;
                    v.pos_product_id = posData.pos_product_id;
                    v.pos_variant_id = posData.pos_variant_id;
                    v.pos_retail_price = posData.pos_retail_price;
                    isUpdated = true;

                    productQuantitySum += newStock;
                    matchedProducts.push({
                        sku: v.sku,
                        name: `${localProduct.name} (${v.label || v.title || ''})`,
                        oldQty: oldStock,
                        qty: newStock,
                        changed: oldStock !== newStock
                    });
                } else {
                    productQuantitySum += (v.stock || 0);
                    if (skuKey) {
                        unmatchedProducts.push({
                            sku: v.sku,
                            name: `${localProduct.name} (${v.label || v.title || 'Phân loại'})`,
                            reason: 'Không tìm thấy SKU biến thể này trên Pancake POS'
                        });
                    }
                }
            });
            if (variants.length > 0 && variants[0].pos_retail_price) {
                details.pos_retail_price = variants[0].pos_retail_price;
            }
        }

        if (isUpdated) {
            details.variants = variants;
            batchStmts.push({
                sql: 'UPDATE products SET quantity = ?, details = ? WHERE id = ?',
                args: [productQuantitySum, JSON.stringify(details), localProduct.id]
            });
        }
    }

    // Execute all updates in a single batch (1 round-trip instead of N)
    if (batchStmts.length > 0) {
        const BATCH_CHUNK = 200; // Turso recommends < 1000 per batch
        for (let i = 0; i < batchStmts.length; i += BATCH_CHUNK) {
            await db.executeBatch(batchStmts.slice(i, i + BATCH_CHUNK));
        }
        console.log(`[POS SYNC] Batch updated ${batchStmts.length} products in DB.`);
    }

    await db.execute({
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_pos_sync', ?)",
        args: [String(Date.now())]
    });

    return {
        totalPosProducts: allPosProducts.length,
        matchedCount: updateCount,
        // Only return changed products (max 100) to avoid huge payload crashing the browser
        matchedProducts: matchedProducts.filter(p => p.changed).slice(0, 100),
        unmatchedProducts: unmatchedProducts.slice(0, 50)
    };
}

// 10. PANCAKE POS PROXY SYNC (SECURE & ALIGNED WITH MOCKUP)

app.get('/api/pos/sync', async (req, res) => {
    const posCredentials = {
        apiKey: process.env.PANCAKE_API_KEY,
        shopId: process.env.PANCAKE_SHOP_ID,
        warehouseId: process.env.PANCAKE_WAREHOUSE_ID
    };

    try {
        const rowsResult = await db.execute("SELECT * FROM settings WHERE key IN ('pos_api_key', 'pos_shop_id', 'pos_warehouse_id')");
        const rows = rowsResult.rows;
        rows.forEach(r => {
            if (r.key === 'pos_api_key' && r.value) posCredentials.apiKey = r.value;
            if (r.key === 'pos_shop_id' && r.value) posCredentials.shopId = r.value;
            if (r.key === 'pos_warehouse_id' && r.value) posCredentials.warehouseId = r.value;
        });
    } catch(e) {}

    if (!posCredentials.apiKey || !posCredentials.shopId) {
        return res.status(400).json({ error: 'Cấu hình kết nối Pancake POS chưa đầy đủ!' });
    }

    try {
        const result = await performPosSync(posCredentials);
        
        // Log sync history to database
        try {
            await db.execute({
                sql: "INSERT INTO pos_sync_history (timestamp, status, total_products, matched_count, error_message) VALUES (?, 'success', ?, ?, '')",
                args: [new Date().toLocaleString('vi-VN'), result.totalPosProducts, result.matchedCount]
            });
        } catch(histErr) {
            console.error('[CRON_DEBUG] Failed to save sync history to db:', histErr.message);
        }

        res.json({
            success: true,
            ...result
        });
    } catch (e) {
        console.error('[POS SYNC ERROR]', e.message);

        // Log failed sync history to database
        try {
            await db.execute({
                sql: "INSERT INTO pos_sync_history (timestamp, status, total_products, matched_count, error_message) VALUES (?, 'failed', 0, 0, ?)",
                args: [new Date().toLocaleString('vi-VN'), e.message]
            });
        } catch(histErr) {
            console.error('[CRON_DEBUG] Failed to save failed sync history to db:', histErr.message);
        }

        res.status(500).json({ error: 'Đồng bộ thất bại: ' + e.message });
    }
});

// 10b. POS SYNC HISTORY (ADMIN ONLY)
app.get('/api/pos/sync-history', authenticateToken, async (req, res) => {
    try {
        const result = await db.execute('SELECT * FROM pos_sync_history ORDER BY id DESC LIMIT 50');
        res.json({ success: true, history: result.rows });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 11. TELEGRAM TEST CONNECTION (ADMIN ONLY)
app.post('/api/telegram/test', authenticateToken, async (req, res) => {
    const { token, chatId } = req.body;
    if (!token || !chatId) {
        return res.status(400).json({ error: 'Token and Chat ID are required' });
    }

    try {
        await sendTelegramMessage(token, chatId, `✅ <b>Kết nối kiểm tra thành công!</b>\nTừ máy chủ ĐHTK Store.\nThời gian: ${new Date().toLocaleString('vi-VN')}`);
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// 12. DEBUG ENDPOINT (ADMIN ONLY - Bao mat)
app.get('/api/debug', authenticateToken, (req, res) => {
    res.json({
        node_env: process.env.NODE_ENV,
        vercel: !!process.env.VERCEL,
        has_turso_url: !!process.env.TURSO_DATABASE_URL,
        has_turso_token: !!process.env.TURSO_AUTH_TOKEN,
        has_jwt_secret: !!process.env.JWT_SECRET
    });
});

// 13. DB TEST ENDPOINT (ADMIN ONLY - Bao mat)
app.get('/api/db-test', authenticateToken, async (req, res) => {
    try {
        const result = await db.execute('SELECT 1 as ok');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ 
            success: false, 
            message: err.message
        });
    }
});

// 14. DỌN DẸP DỮ LIỆU TEST RÁC
app.get('/api/clean-test-data', async (req, res) => {
    if (req.query.secret !== 'xoatatcatest') {
        return res.status(403).json({ error: 'Sai mã bí mật!' });
    }
    try {
        const result = await db.execute("DELETE FROM products WHERE name LIKE 'Test %' OR sku LIKE 'SKU%'");
        res.json({ success: true, message: 'Đã dọn dẹp sạch sẽ toàn bộ các sản phẩm rác (Test 0, Test 1...) khỏi CSDL!' });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// HELPER GENERATE SLUG
function generateSlug(title) {
    return title.toLowerCase()
        .replace(/đ/g, 'd').replace(/Đ/g, 'd')
        .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a')
        .replace(/[èéẹẻẽêềếệểễ]/g, 'e')
        .replace(/[ìíịỉĩ]/g, 'i')
        .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o')
        .replace(/[ùúụủũưừứựửữ]/g, 'u')
        .replace(/[ỳýỵỷỹ]/g, 'y')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 120);
}

// --- BLOG API ENDPOINTS ---

// 1. PUBLIC: GET BLOG POSTS (PAGINATED)
app.get('/api/blog', async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));
        const offset = (page - 1) * limit;

        const sort = req.query.sort || 'newest';
        let orderClause = "ORDER BY created_at DESC";
        if (sort === 'oldest') orderClause = "ORDER BY created_at ASC";

        const countResult = await db.execute("SELECT COUNT(*) as total FROM blog_posts WHERE status = 'published'");
        const total = countResult.rows[0]?.total || 0;

        const result = await db.execute({
            sql: `SELECT id, title, slug, summary, keyword, cover_image, created_at, updated_at FROM blog_posts WHERE status = 'published' ${orderClause} LIMIT ? OFFSET ?`,
            args: [limit, offset]
        });

        res.json({
            posts: result.rows,
            pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. PUBLIC: GET SINGLE BLOG POST BY SLUG (SUPPORTS DRAFT PREVIEW FOR ADMIN & DECODED SLUGS)
app.get('/api/blog/:slug', async (req, res) => {
    try {
        const rawSlug = req.params.slug;
        const decodedSlug = decodeURIComponent(rawSlug);
        
        let result = await db.execute({
            sql: "SELECT * FROM blog_posts WHERE slug = ? OR slug = ? OR id = ? LIMIT 1",
            args: [rawSlug, decodedSlug, decodedSlug]
        });

        if (result.rows.length === 0) {
            result = await db.execute({
                sql: "SELECT * FROM blog_posts WHERE slug LIKE ? LIMIT 1",
                args: [`%${decodedSlug}%`]
            });
        }

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Bài viết không tồn tại' });
        }

        const post = result.rows[0];
        
        let relatedResult = { rows: [] };
        try {
            relatedResult = await db.execute({
                sql: "SELECT id, title, slug, summary, cover_image, created_at FROM blog_posts WHERE slug != ? ORDER BY RANDOM() LIMIT 3",
                args: [post.slug || decodedSlug]
            });
        } catch(err) {}
        
        post.related_posts = relatedResult.rows || [];
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        res.json(post);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. ADMIN: GET ALL BLOG POSTS (INCLUDING DRAFTS)
app.get('/api/admin/blog', authenticateToken, async (req, res) => {
    try {
        const result = await db.execute("SELECT id, title, slug, summary, keyword, cover_image, status, created_at, updated_at FROM blog_posts ORDER BY created_at DESC");
        res.json(result.rows);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 4. ADMIN: CREATE BLOG POST
app.post('/api/admin/blog', authenticateToken, async (req, res) => {
    try {
        const { title, content, keyword, status, summary, cover_image } = req.body;
        if (!title || !content) return res.status(400).json({ error: 'Title và Content là bắt buộc' });

        const id = crypto.randomUUID();
        let slug = generateSlug(title);
        if (!slug) slug = `post-${Date.now()}`;
        const now = new Date().toISOString();
        const finalSummary = summary || content.replace(/[#*>\-\n]/g, ' ').substring(0, 160).trim();

        await db.execute({
            sql: `INSERT INTO blog_posts (id, title, slug, summary, content, keyword, cover_image, status, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [id, title, slug, finalSummary, content, keyword || '', cover_image || '', status || 'draft', now, now]
        });

        if (status === 'published') {
            const host = req.headers['x-forwarded-host'] || req.headers.host || 'thohong.top';
            const protocol = req.headers['x-forwarded-proto'] || 'https';
            const fullBlogUrl = `${protocol}://${host}/blog/${slug}`;
            try {
                await pushToGoogleIndexingApi(fullBlogUrl, 'URL_UPDATED', id);
                await shareBlogToTelegram(fullBlogUrl, title, finalSummary, cover_image || '', id);
                await shareBlogToFacebook(fullBlogUrl, title, finalSummary, cover_image || '', id);
                await triggerMakeWebhook({ id, title, slug, excerpt: finalSummary, image: cover_image, created_at: now });
            } catch(e) {
                console.error('[AUTO-INDEX/SOCIAL POST ERROR]', e.message);
            }
        }

        res.json({ success: true, id, slug });
    } catch (e) {
        if (e.message && e.message.includes('UNIQUE')) {
            return res.status(400).json({ error: 'Slug đã tồn tại. Hãy đổi tiêu đề bài viết.' });
        }
        res.status(500).json({ error: e.message });
    }
});

// 5. ADMIN: UPDATE BLOG POST
app.put('/api/admin/blog/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, content, keyword, status, summary, cover_image } = req.body;
        if (!title || !content) return res.status(400).json({ error: 'Title và Content là bắt buộc' });

        const slug = generateSlug(title);
        const now = new Date().toISOString();
        const finalSummary = summary || content.replace(/[#*>\-\n]/g, ' ').substring(0, 160).trim();

        await db.execute({
            sql: `UPDATE blog_posts SET title = ?, slug = ?, summary = ?, content = ?, keyword = ?, cover_image = ?, status = ?, updated_at = ? WHERE id = ?`,
            args: [title, slug, finalSummary, content, keyword || '', cover_image || '', status || 'draft', now, id]
        });

        if (status === 'published') {
            const host = req.headers['x-forwarded-host'] || req.headers.host || 'thohong.top';
            const protocol = req.headers['x-forwarded-proto'] || 'https';
            const fullBlogUrl = `${protocol}://${host}/blog/${slug}`;
            try {
                await pushToGoogleIndexingApi(fullBlogUrl, 'URL_UPDATED', id);
                await shareBlogToTelegram(fullBlogUrl, title, finalSummary, cover_image || '', id);
                await shareBlogToFacebook(fullBlogUrl, title, finalSummary, cover_image || '', id);
                await triggerMakeWebhook({ id, title, slug, excerpt: finalSummary, image: cover_image, created_at: now });
            } catch(e) {
                console.error('[AUTO-INDEX/SOCIAL UPDATE ERROR]', e.message);
            }
        }

        res.json({ success: true, id, slug });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5.5 ADMIN: MANUAL TELEGRAM SHARE NOW
app.post('/api/admin/social/telegram-share-now', authenticateToken, async (req, res) => {
    try {
        const { blogId, customUrl } = req.body;
        
        let title = 'Bài viết mới';
        let summary = '';
        let coverImage = '';
        let fullBlogUrl = customUrl || '';
        let targetBlogId = blogId || null;

        const host = req.headers['x-forwarded-host'] || req.headers.host || 'thohong.top';
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const baseUrl = `${protocol}://${host}`;

        if (blogId) {
            const postRes = await db.execute({
                sql: "SELECT * FROM blog_posts WHERE id = ? OR slug = ? LIMIT 1",
                args: [blogId, blogId]
            });
            const post = postRes.rows?.[0];
            if (post) {
                title = post.title;
                summary = post.summary || post.content;
                coverImage = post.cover_image || '';
                const cleanSlug = String(post.slug || '').replace(/^\/blog\//, '');
                fullBlogUrl = `${baseUrl}/blog/${cleanSlug}`;
                targetBlogId = post.id;
            }
        }

        // Tự động lấy bài mới nhất hoặc tạo bài viết thử nghiệm mẫu nếu blogId rỗng
        if (!fullBlogUrl) {
            const latestRes = await db.execute("SELECT * FROM blog_posts ORDER BY created_at DESC LIMIT 1");
            const latestPost = latestRes.rows?.[0];
            if (latestPost) {
                title = latestPost.title;
                summary = latestPost.summary || latestPost.content;
                coverImage = latestPost.cover_image || '';
                const cleanSlug = String(latestPost.slug || '').replace(/^\/blog\//, '');
                fullBlogUrl = `${baseUrl}/blog/${cleanSlug}`;
                targetBlogId = latestPost.id;
            } else {
                title = "📌 Bài Viết Mẫu Thử Nghiệm Kênh Telegram SEO";
                summary = "Đây là bài viết thử nghiệm kết nối hệ thống tự động chia sẻ bài viết lên Kênh Telegram. Khi bài viết mới xuất bản, bài viết sẽ tự động hiển thị tại đây!";
                fullBlogUrl = `${baseUrl}/blog`;
            }
        }

        const overrideToken = req.body.blogToken || req.body.overrideToken || '';
        const overrideChatId = req.body.blogChatId || req.body.overrideChatId || '';
        const result = await shareBlogToTelegram(fullBlogUrl, title, summary, coverImage, targetBlogId, overrideToken, overrideChatId);
        if (result.error) return res.status(400).json({ error: result.error });
        if (result.skipped) return res.status(400).json({ error: result.reason });

        res.json({ success: true, message: `Đã chia sẻ thành công bài viết lên Kênh Telegram!` });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/blog/indexing-posts', authenticateToken, async (req, res) => {
    try {
        try {
            await db.execute("ALTER TABLE blog_posts ADD COLUMN make_shared_at TEXT DEFAULT ''");
        } catch(e) {}
        const result = await db.execute("SELECT id, title, slug, summary, status, created_at, make_shared_at, telegram_shared_at, facebook_shared_at FROM blog_posts ORDER BY created_at DESC");
        res.json({ success: true, posts: result.rows || [] });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// 5.6 ADMIN: TELEGRAM SHARE BATCH (TỰ ĐỘNG CHIA SẺ BÀI CHƯA SHARE)
app.post('/api/admin/social/telegram-share-batch', authenticateToken, async (req, res) => {
    try {
        try {
            await db.execute("ALTER TABLE blog_posts ADD COLUMN telegram_shared_at TEXT DEFAULT ''");
        } catch(e) {}

        const postsRes = await db.execute("SELECT * FROM blog_posts ORDER BY created_at DESC");
        const unshared = (postsRes.rows || []).filter(p => !p.telegram_shared_at);

        if (unshared.length === 0) {
            return res.json({ success: true, count: 0, message: '🎉 Tất cả bài viết đã được chia sẻ Telegram từ trước!' });
        }

        const host = req.headers['x-forwarded-host'] || req.headers.host || 'thohong.top';
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const baseUrl = `${protocol}://${host}`;

        let successCount = 0;
        let failCount = 0;

        for (const post of unshared) {
            const cleanSlug = String(post.slug || '').replace(/^\/blog\//, '');
            const fullBlogUrl = `${baseUrl}/blog/${cleanSlug}`;
            const summary = post.summary || post.content;
            
            const shareRes = await shareBlogToTelegram(fullBlogUrl, post.title, summary, post.cover_image || '', post.id);
            if (shareRes.success || shareRes.ok) {
                successCount++;
            } else {
                failCount++;
            }
        }

        res.json({
            success: true,
            message: `Đã chia sẻ hàng loạt ${successCount}/${unshared.length} bài viết chưa share lên Kênh Telegram!`,
            successCount,
            failCount,
            total: unshared.length
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// 5.7 ADMIN: FACEBOOK SHARE NOW & BATCH
app.post('/api/admin/social/facebook-share-now', authenticateToken, async (req, res) => {
    try {
        const { blogId, fbPageId, fbPageToken, fbGroupId, fbGroupToken } = req.body;
        const host = req.headers['x-forwarded-host'] || req.headers.host || 'thohong.top';
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const baseUrl = `${protocol}://${host}`;

        let fullBlogUrl = req.body.url || '';
        let title = req.body.title || '';
        let summary = req.body.summary || '';
        let coverImage = req.body.coverImage || '';
        let targetBlogId = blogId || null;

        if (blogId) {
            const blogRes = await db.execute({
                sql: "SELECT * FROM blog_posts WHERE id = ? OR slug = ?",
                args: [blogId, blogId]
            });
            const post = blogRes.rows?.[0];
            if (post) {
                title = post.title;
                summary = post.summary || post.content;
                coverImage = post.cover_image || '';
                const cleanSlug = String(post.slug || '').replace(/^\/blog\//, '');
                fullBlogUrl = `${baseUrl}/blog/${cleanSlug}`;
                targetBlogId = post.id;
            }
        }

        if (!fullBlogUrl) {
            const latestRes = await db.execute("SELECT * FROM blog_posts ORDER BY created_at DESC LIMIT 1");
            const latestPost = latestRes.rows?.[0];
            if (latestPost) {
                title = latestPost.title;
                summary = latestPost.summary || latestPost.content;
                coverImage = latestPost.cover_image || '';
                const cleanSlug = String(latestPost.slug || '').replace(/^\/blog\//, '');
                fullBlogUrl = `${baseUrl}/blog/${cleanSlug}`;
                targetBlogId = latestPost.id;
            } else {
                title = "📌 Bài Viết Mẫu Thử Nghiệm Facebook Fanpage & Group";
                summary = "Đây là bài viết thử nghiệm kết nối hệ thống tự động chia sẻ bài viết lên Facebook Fanpage / Group. Khi bài viết mới xuất bản, bài viết sẽ tự động hiển thị tại đây!";
                fullBlogUrl = `${baseUrl}/blog`;
            }
        }

        const result = await shareBlogToFacebook(fullBlogUrl, title, summary, coverImage, targetBlogId, fbPageId, fbPageToken, fbGroupId, fbGroupToken);
        if (result.error) return res.status(400).json({ error: result.error });
        if (result.skipped) return res.status(400).json({ error: result.reason });

        const detailMsgs = (result.results || []).map(r => {
            if (r.success) return `✅ ${r.type === 'fanpage' ? 'Fanpage' : 'Group'}: Thành công (ID: ${r.postId})`;
            return `❌ ${r.type === 'fanpage' ? 'Fanpage' : 'Group'}: ${r.error}`;
        }).join('\n');

        res.json({ success: true, message: `Kết quả đăng bài Facebook:\n${detailMsgs}`, results: result.results });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/social/facebook-share-batch', authenticateToken, async (req, res) => {
    try {
        try {
            await db.execute("ALTER TABLE blog_posts ADD COLUMN facebook_shared_at TEXT DEFAULT ''");
        } catch(e) {}

        const postsRes = await db.execute("SELECT * FROM blog_posts ORDER BY created_at DESC");
        const unshared = (postsRes.rows || []).filter(p => !p.facebook_shared_at);

        if (unshared.length === 0) {
            return res.json({ success: true, count: 0, message: '🎉 Tất cả bài viết đã được chia sẻ Facebook từ trước!' });
        }

        const host = req.headers['x-forwarded-host'] || req.headers.host || 'thohong.top';
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const baseUrl = `${protocol}://${host}`;

        let successCount = 0;
        let failCount = 0;

        for (const post of unshared) {
            const cleanSlug = String(post.slug || '').replace(/^\/blog\//, '');
            const fullBlogUrl = `${baseUrl}/blog/${cleanSlug}`;
            const summary = post.summary || post.content;
            
            const shareRes = await shareBlogToFacebook(fullBlogUrl, post.title, summary, post.cover_image || '', post.id);
            if (shareRes.success) {
                successCount++;
            } else {
                failCount++;
            }
        }

        res.json({
            success: true,
            message: `Đã chia sẻ hàng loạt ${successCount}/${unshared.length} bài viết chưa share lên Facebook!`,
            successCount,
            failCount,
            total: unshared.length
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// 6. ADMIN: DELETE BLOG POST
app.delete('/api/admin/blog/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        await db.execute({
            sql: "DELETE FROM blog_posts WHERE id = ?",
            args: [id]
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 7. ADMIN: UPLOAD IMAGE TO IMGUR PROXY
app.post('/api/admin/upload-imgur', authenticateToken, async (req, res) => {
    try {
        const { image } = req.body;
        if (!image) return res.status(400).json({ error: 'Thiếu dữ liệu hình ảnh' });

        const cleanBase64 = image.replace(/^data:image\/\w+;base64,/, '');
        const response = await fetch('https://api.imgur.com/3/image', {
            method: 'POST',
            headers: {
                'Authorization': 'Client-ID 54477642c1b5708',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ image: cleanBase64, type: 'base64' })
        });
        const data = await response.json();
        if (data.success && data.data && data.data.link) {
            res.json({ success: true, link: data.data.link });
        } else {
            res.status(500).json({ error: data.data?.error || 'Không thể upload ảnh lên Imgur' });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 8. ADMIN: AI DEEPSEEK KEYWORD SUGGESTION
app.post('/api/admin/blog/suggest-keywords', authenticateToken, async (req, res) => {
    try {
        const settingsResult = await db.execute("SELECT key, value FROM settings WHERE key IN ('deepseekApiKey', 'storeName')");
        const settingsMap = {};
        settingsResult.rows.forEach(r => { settingsMap[r.key] = r.value; });
        const apiKey = settingsMap['deepseekApiKey'];
        if (!apiKey) return res.status(400).json({ error: 'Chưa cấu hình DeepSeek API Key trong Admin Panel.' });

        const productsResult = await db.execute("SELECT DISTINCT category FROM products WHERE status = 'active' OR status IS NULL OR status = '' LIMIT 30");
        const categories = productsResult.rows.map(r => r.category).filter(Boolean);
        const storeName = settingsMap['storeName'] || 'Thỏ Hồng / ĐHTK';

        const prompt = `Bạn là chuyên gia SEO hàng đầu cho website e-commerce Việt Nam.
Cửa hàng "${storeName}" chuyên kinh doanh các nhóm ngành hàng: ${categories.join(', ')}.

Hãy gợi ý 10 từ khóa SEO tiềm năng nhất cho blog của cửa hàng.
Mỗi từ khóa phải:
- Có nhu cầu tìm kiếm cao từ khách hàng mua sỉ/lẻ Việt Nam
- Dễ xếp hạng trang 1 Google (tập trung từ khóa ngách/long-tail)
- Phù hợp với sản phẩm/ngành hàng cửa hàng đang bán

Trả về kết quả dưới dạng duy nhất một mảng JSON array, mỗi phần tử có định dạng:
[
  {"keyword": "từ khóa SEO", "reason": "lý do chọn từ khóa", "difficulty": "Dễ|Trung bình|Khó"}
]
CHỈ trả về JSON array, không viết thêm lời dẫn hay giải thích.`;

        let response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'deepseek-v4-pro',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.7
            })
        });

        let data = await response.json();
        if (data.error) {
            response = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.7 })
            });
            data = await response.json();
            if (data.error) return res.status(400).json({ error: data.error.message || 'Lỗi từ DeepSeek API' });
        }

        const text = data.choices?.[0]?.message?.content || '[]';
        let keywords = [];
        try {
            const jsonMatch = text.match(/\[[\s\S]*\]/);
            keywords = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
        } catch(e) { keywords = []; }

        // Tự động đẩy danh sách từ khóa gợi ý vào CSDL seo_keywords
        const now = new Date().toISOString();
        for (const k of keywords) {
            if (k.keyword) {
                const kwId = 'kw_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
                try {
                    await db.execute({
                        sql: "INSERT OR IGNORE INTO seo_keywords (id, keyword, difficulty, reason, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
                        args: [kwId, k.keyword.trim(), k.difficulty || 'Trung bình', k.reason || '', now]
                    });
                } catch(err) {}
            }
        }

        res.json({ keywords });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 8.1 ADMIN: GET KEYWORDS QUEUE
app.get('/api/admin/keywords', authenticateToken, async (req, res) => {
    try {
        const result = await db.execute("SELECT * FROM seo_keywords ORDER BY created_at DESC");
        res.json(result.rows || []);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 8.2 ADMIN: ADD MANUAL KEYWORD TO QUEUE
app.post('/api/admin/keywords', authenticateToken, async (req, res) => {
    try {
        const { keyword, difficulty, reason } = req.body;
        if (!keyword) return res.status(400).json({ error: 'Thiếu từ khóa' });

        const id = 'kw_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
        const now = new Date().toISOString();

        await db.execute({
            sql: "INSERT INTO seo_keywords (id, keyword, difficulty, reason, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
            args: [id, keyword.trim(), difficulty || 'Thủ công', reason || 'Nhập thủ công từ Admin', now]
        });
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 8.3 ADMIN: DELETE KEYWORD FROM QUEUE
app.delete('/api/admin/keywords/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        await db.execute({
            sql: "DELETE FROM seo_keywords WHERE id = ?",
            args: [id]
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 9. ADMIN: AI DEEPSEEK BLOG WRITER
app.post('/api/admin/blog/generate', authenticateToken, async (req, res) => {
    try {
        const { keyword, keywordId } = req.body;
        if (!keyword) return res.status(400).json({ error: 'Thiếu từ khóa SEO' });

        const settingsResult = await db.execute("SELECT key, value FROM settings WHERE key IN ('deepseekApiKey', 'storeName')");
        const settingsMap = {};
        settingsResult.rows.forEach(r => { settingsMap[r.key] = r.value; });
        const apiKey = settingsMap['deepseekApiKey'];
        if (!apiKey) return res.status(400).json({ error: 'Chưa cấu hình DeepSeek API Key.' });

        const host = req.headers['x-forwarded-host'] || req.headers.host || 'thohong.top';
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const baseUrl = `${protocol}://${host}`;
        const storeName = settingsMap['storeName'] || 'Thỏ Hồng / ĐHTK';

        // 1. Phân tích từ khóa để lọc 5 sản phẩm khớp chính xác nhất từ CSDL kho hàng
        const postTopic = detectStationeryTopic(keyword);
        let topicKeywords = [];
        if (postTopic === 'notebook') topicKeywords = ['sổ', 'vở', 'tập', 'bìa da', 'giấy'];
        else if (postTopic === 'pen') topicKeywords = ['bút', 'chì', 'viết', 'dạ', 'gel', 'marker'];
        else if (postTopic === 'pencil_case') topicKeywords = ['bóp', 'hộp bút', 'túi', 'pouch'];

        const rawWords = String(keyword || '').split(/\s+/).filter(w => w.length > 2);
        rawWords.forEach(w => {
            if (!topicKeywords.includes(w.toLowerCase())) topicKeywords.push(w.toLowerCase());
        });

        let matchedProductsMap = new Map();
        for (const kw of topicKeywords) {
            if (matchedProductsMap.size >= 5) break;
            try {
                const pRes = await db.execute({
                    sql: "SELECT id, name, category, price, imageUrl, details FROM products WHERE (status = 'active' OR status IS NULL OR status = '') AND imageUrl IS NOT NULL AND imageUrl != '' AND (name LIKE ? OR category LIKE ?) LIMIT 5",
                    args: [`%${kw}%`, `%${kw}%`]
                });
                (pRes.rows || []).forEach(p => {
                    if (matchedProductsMap.size < 5 && !matchedProductsMap.has(p.id)) {
                        matchedProductsMap.set(p.id, p);
                    }
                });
            } catch(err) {}
        }

        if (matchedProductsMap.size < 5) {
            try {
                const fbRes = await db.execute("SELECT id, name, category, price, imageUrl, details FROM products WHERE (status = 'active' OR status IS NULL OR status = '') AND imageUrl IS NOT NULL AND imageUrl != '' LIMIT 5");
                (fbRes.rows || []).forEach(p => {
                    if (matchedProductsMap.size < 5 && !matchedProductsMap.has(p.id)) {
                        matchedProductsMap.set(p.id, p);
                    }
                });
            } catch(err) {}
        }

        const selectedProducts = Array.from(matchedProductsMap.values());
        
        const availableImages = [];
        const productsList = selectedProducts.map(p => {
            const nameSlug = toAsciiSlug(p.name || '');
            const cleanId = String(p.id || '').replace(/^SP/i, '');
            const link = `${baseUrl}/san-pham/${encodeURIComponent(nameSlug)}-p${cleanId}`;
            
            const pImgs = [];
            if (p.imageUrl) {
                const fullUrl = p.imageUrl.startsWith('http') ? p.imageUrl : `${baseUrl}${p.imageUrl.startsWith('/') ? '' : '/'}${p.imageUrl}`;
                pImgs.push(fullUrl);
            }
            try {
                if (p.details) {
                    const parsed = JSON.parse(p.details);
                    if (Array.isArray(parsed.images)) {
                        parsed.images.forEach(img => {
                            if (img && typeof img === 'string') {
                                const fullUrl = img.startsWith('http') ? img : `${baseUrl}${img.startsWith('/') ? '' : '/'}${img}`;
                                if (!pImgs.includes(fullUrl)) pImgs.push(fullUrl);
                            }
                        });
                    }
                }
            } catch(e) {}

            pImgs.forEach(imgUrl => {
                if (!availableImages.some(i => i.url === imgUrl) && availableImages.length < 12) {
                    availableImages.push({ url: imgUrl, productName: p.name });
                }
            });

            return `- [${p.name}](${link}) (Giá: ${p.price ? p.price + 'đ' : 'Liên hệ'})`;
        }).join('\n');

        if (availableImages.length < 3) {
            const stockList = STATIONERY_STOCK_IMAGES[postTopic] || STATIONERY_STOCK_IMAGES['stationery_general'];
            for (const stockUrl of stockList) {
                if (availableImages.length >= 5) break;
                if (!availableImages.some(i => i.url === stockUrl)) {
                    availableImages.push({ url: stockUrl, productName: `Sản phẩm ${keyword}` });
                }
            }
        }

        const imagesListPrompt = availableImages.length > 0
            ? availableImages.map((img, idx) => `Ảnh ${idx + 1}: ${img.url} (Sản phẩm: ${img.productName})`).join('\n')
            : 'Không có danh sách hình ảnh.';

        const prompt = `Bạn là nhà báo chuyên nghiệp và chuyên gia SEO thương mại điện tử Việt Nam.
Hãy viết 1 bài blog chất lượng cao chuẩn SEO cho cửa hàng "${storeName}" dựa trên từ khóa chính: "${keyword}".

DANH SÁCH SẢN PHẨM HIỆN CÓ TẠI CỬA HÀNG ĐỂ CHÈN INTERNAL LINK:
${productsList || 'Không có danh sách sản phẩm cụ thể.'}

DANH SÁCH HÌNH ẢNH SẢN PHẨM KHẢ DỤNG ĐỂ CHÈN VÀO BÀI VIẾT:
${imagesListPrompt}

YÊU CẦU SEO CHI TIẾT:
1. ĐỘ DÀI & ĐOẠN VĂN: Bài viết từ 1000 - 1500 từ. Chia thành các đoạn văn từ 3-4 câu giúp người đọc dễ theo dõi trên di động.
2. THẺ HEADING: 
   - Tiêu đề chính (H1) chứa từ khóa chính.
   - 3 - 5 thẻ H2 (dùng ## trong Markdown), trong đó có chứa từ khóa liên quan.
   - Các thẻ H3 (dùng ### trong Markdown) để làm rõ ý.
3. MẬT ĐỘ TỪ KHÓA: Từ khóa "${keyword}" xuất hiện 3-5 lần một cách tự nhiên (ngay trong 100 từ đầu tiên, giữa bài và kết bài).
4. CHÈN INTERNAL LINK SẢN PHẨM: Bắt buộc chọn 2 - 3 sản phẩm phù hợp nhất từ danh sách sản phẩm ở trên và chèn BẮT BUỘC ĐÚNG NGUYÊN VẸN cú pháp Markdown link: [Tên sản phẩm](Link) được cấp ở trên vào bài viết (ví dụ: "Bạn có thể tham khảo thêm [Tên sản phẩm](https://...)..."). TUYỆT ĐỐI KHÔNG tự bịa URL, KHÔNG tự thêm/bớt ký tự trong Link.
5. CHÈN 3 HÌNH ẢNH SẢN PHẨM VÀO BÀI VIẾT (BẮT BUỘC): Bắt buộc lấy đúng 3 URL hình ảnh từ danh sách hình ảnh khả dụng ở trên và chèn rải rác vào bài viết bằng cú pháp Markdown: \`![Mô tả ảnh sinh động chứa từ khóa SEO](URL_ảnh)\`. Đặt 3 hình ảnh này ở các vị trí thích hợp ngay sau các thẻ H2 hoặc H3 để minh họa bài viết sinh động, trực quan. KHÔNG TỰ BỊA LINK ẢNH KHÁC KHÔNG CÓ TRONG DANH SÁCH.
6. ĐỊNH DẠNG MARKDOWN: Dùng **in đậm**, gạch đầu dòng (-) để bài viết sống động.
7. LỜI KÊU GỌI HÀNG (CTA): Đoạn cuối kết bài kêu gọi khách hàng đặt hàng hoặc liên hệ mua sỉ/lẻ tại ${storeName}.

ĐỊNH DẠNG TRẢ VỀ BẮT BUỘC (TUÂN THỦ CHÍNH XÁC CÁC THẺ PHÂN PHẠM):
##TITLE##
[Viết tiêu đề bài viết hấp dẫn, chứa từ khóa, dưới 65 ký tự]
##SUMMARY##
[Viết đoạn tóm tắt Meta Description chuẩn SEO từ 120-150 ký tự chứa từ khóa]
##CONTENT##
[Nội dung bài viết chi tiết bằng định dạng Markdown chứa 3 hình ảnh sản phẩm]`;

        let response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'deepseek-v4-pro',
                messages: [{ role: 'user', content: prompt }],
                temperature: 0.7
            })
        });

        let data = await response.json();
        if (data.error) {
            response = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.7 })
            });
            data = await response.json();
            if (data.error) return res.status(400).json({ error: data.error.message || 'Lỗi từ DeepSeek API' });
        }

        const text = data.choices?.[0]?.message?.content || '';

        let title = '';
        let summary = '';
        let content = '';

        const titleMatch = text.match(/##TITLE##\s*(.*?)(?=##SUMMARY##)/s);
        const summaryMatch = text.match(/##SUMMARY##\s*(.*?)(?=##CONTENT##)/s);
        const contentMatch = text.match(/##CONTENT##\s*([\s\S]*)/);

        title = titleMatch ? titleMatch[1].trim() : `${keyword} - Hướng dẫn chi tiết`;
        summary = summaryMatch ? summaryMatch[1].trim().substring(0, 160) : '';
        content = contentMatch ? contentMatch[1].trim() : text;

        let coverImage = '';
        const firstImgMatch = content.match(/!\[.*?\]\((https?:\/\/[^\s\)]+)\)/);
        if (firstImgMatch) {
            coverImage = firstImgMatch[1];
        } else if (availableImages.length > 0) {
            coverImage = availableImages[0].url;
        }

        if (keywordId) {
            try {
                await db.execute({
                    sql: "UPDATE seo_keywords SET status = 'generated' WHERE id = ?",
                    args: [keywordId]
                });
            } catch(e) {}
        } else {
            try {
                await db.execute({
                    sql: "UPDATE seo_keywords SET status = 'generated' WHERE keyword = ?",
                    args: [keyword.trim()]
                });
            } catch(e) {}
        }

        res.json({ title, summary, content, coverImage, keyword });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 9.5 ADMIN: AUTO ENRICH EXISTING BLOG POSTS WITH PRODUCT IMAGES
app.post('/api/admin/blog/enrich-images', authenticateToken, async (req, res) => {
    try {
        const host = req.headers['x-forwarded-host'] || req.headers.host || 'thohong.top';
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const baseUrl = `${protocol}://${host}`;

        // 1. Fetch available product images
        const prodResult = await db.execute("SELECT id, name, imageUrl, details FROM products WHERE (status = 'active' OR status IS NULL OR status = '') AND imageUrl IS NOT NULL AND imageUrl != '' LIMIT 30");
        
        const availableImages = [];
        prodResult.rows.forEach(p => {
            const pImgs = [];
            if (p.imageUrl) {
                const fullUrl = p.imageUrl.startsWith('http') ? p.imageUrl : `${baseUrl}${p.imageUrl.startsWith('/') ? '' : '/'}${p.imageUrl}`;
                pImgs.push(fullUrl);
            }
            try {
                if (p.details) {
                    const parsed = JSON.parse(p.details);
                    if (Array.isArray(parsed.images)) {
                        parsed.images.forEach(img => {
                            if (img && typeof img === 'string') {
                                const fullUrl = img.startsWith('http') ? img : `${baseUrl}${img.startsWith('/') ? '' : '/'}${img}`;
                                if (!pImgs.includes(fullUrl)) pImgs.push(fullUrl);
                            }
                        });
                    }
                }
            } catch(e) {}

            pImgs.forEach(imgUrl => {
                if (!availableImages.some(i => i.url === imgUrl)) {
                    availableImages.push({ url: imgUrl, productName: p.name || 'Sản phẩm Thỏ Hồng' });
                }
            });
        });

        if (availableImages.length === 0) {
            return res.status(400).json({ error: 'Không tìm thấy hình ảnh sản phẩm nào trong hệ thống.' });
        }

        // 2. Fetch all blog posts
        const postsResult = await db.execute("SELECT id, title, content, cover_image FROM blog_posts");
        const posts = postsResult.rows || [];
        let updatedCount = 0;
        let imgIdx = 0;

        for (const post of posts) {
            let content = post.content || '';
            let coverImage = post.cover_image || '';
            let isModified = false;

            const existingImgMatches = content.match(/!\[.*?\]\((https?:\/\/[^\s\)]+)\)/g) || [];

            // Set cover image if missing
            if (!coverImage) {
                if (existingImgMatches.length > 0) {
                    const firstUrlMatch = existingImgMatches[0].match(/!\[.*?\]\((https?:\/\/[^\s\)]+)\)/);
                    if (firstUrlMatch) coverImage = firstUrlMatch[1];
                }
                if (!coverImage && availableImages.length > 0) {
                    coverImage = availableImages[imgIdx % availableImages.length].url;
                }
                isModified = true;
            }

            // Insert images into content if fewer than 2 images
            if (existingImgMatches.length < 2) {
                const headings = content.split(/(?=\n##\s+|\n###\s+)/);
                if (headings.length > 1) {
                    let newContent = headings[0];
                    for (let i = 1; i < headings.length; i++) {
                        newContent += headings[i];
                        if (i <= 2 && (existingImgMatches.length + i) <= 3) {
                            const imgToInsert = availableImages[(imgIdx++) % availableImages.length];
                            newContent += `\n\n![${imgToInsert.productName}](${imgToInsert.url})\n\n`;
                        }
                    }
                    content = newContent;
                    isModified = true;
                } else {
                    const paragraphs = content.split('\n\n');
                    if (paragraphs.length >= 3) {
                        const img1 = availableImages[(imgIdx++) % availableImages.length];
                        const img2 = availableImages[(imgIdx++) % availableImages.length];
                        paragraphs.splice(2, 0, `![${img1.productName}](${img1.url})`);
                        if (paragraphs.length >= 6) {
                            paragraphs.splice(5, 0, `![${img2.productName}](${img2.url})`);
                        }
                        content = paragraphs.join('\n\n');
                        isModified = true;
                    }
                }
            }

            if (isModified) {
                const now = new Date().toISOString();
                await db.execute({
                    sql: "UPDATE blog_posts SET content = ?, cover_image = ?, updated_at = ? WHERE id = ?",
                    args: [content, coverImage, now, post.id]
                });
                updatedCount++;
            }
        }

        // Clear SSR cache so new post covers and content render immediately
        Object.keys(ssrSeoCache).forEach(k => { if (k.startsWith('blog_')) delete ssrSeoCache[k]; });

        res.json({ success: true, count: updatedCount, message: `Đã bổ sung hình ảnh sản phẩm thành công cho ${updatedCount} bài viết!` });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 9.5b GOOGLE INDEXING API V3 ENGINE (NATIVE RSA-256 JWT AUTH)
let _cachedGoogleAccessToken = { token: '', expiresAt: 0 };

function base64UrlEncode(str) {
    return Buffer.from(str)
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

async function getGoogleAccessToken(serviceAccountJsonStr) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (_cachedGoogleAccessToken.token && _cachedGoogleAccessToken.expiresAt > nowSec + 120) {
        return _cachedGoogleAccessToken.token;
    }

    let serviceAccount;
    try {
        serviceAccount = typeof serviceAccountJsonStr === 'string' ? JSON.parse(serviceAccountJsonStr) : serviceAccountJsonStr;
    } catch(e) {
        throw new Error('Service Account JSON Key không hợp lệ (lỗi parse JSON).');
    }

    if (!serviceAccount.client_email || !serviceAccount.private_key) {
        throw new Error('Service Account JSON Key thiếu client_email hoặc private_key.');
    }

    const header = { alg: "RS256", typ: "JWT" };
    const claimSet = {
        iss: serviceAccount.client_email,
        scope: "https://www.googleapis.com/auth/indexing",
        aud: "https://oauth2.googleapis.com/token",
        exp: nowSec + 3600,
        iat: nowSec
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));
    const signatureInput = `${encodedHeader}.${encodedClaimSet}`;

    const signer = crypto.createSign('RSA-SHA256');
    signer.update(signatureInput);

    let privateKey = serviceAccount.private_key;
    if (typeof privateKey === 'string' && privateKey.includes('\\n')) {
        privateKey = privateKey.replace(/\\n/g, '\n');
    }

    const signature = signer.sign(privateKey, 'base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

    const jwtToken = `${signatureInput}.${signature}`;

    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: jwtToken
        })
    });

    const tokenData = await tokenResp.json();
    if (!tokenResp.ok || tokenData.error) {
        throw new Error(`Lỗi cấp Access Token từ Google OAuth2: ${tokenData.error_description || tokenData.error || tokenResp.statusText}`);
    }

    _cachedGoogleAccessToken = {
        token: tokenData.access_token,
        expiresAt: nowSec + (tokenData.expires_in || 3600)
    };

    return tokenData.access_token;
}

async function pushToGoogleIndexingApi(targetUrl, actionType = 'URL_UPDATED', blogId = null) {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS google_indexing_logs (
            id TEXT PRIMARY KEY,
            url TEXT NOT NULL,
            action_type TEXT DEFAULT 'URL_UPDATED',
            status TEXT DEFAULT 'pending',
            response_message TEXT DEFAULT '',
            created_at TEXT NOT NULL
        )`);
    } catch(e) {}

    const logId = 'gidx_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const nowIso = new Date().toISOString();

    try {
        const keyRes = await db.execute("SELECT value FROM settings WHERE key = 'googleServiceAccountJson'");
        const jsonStr = keyRes.rows?.[0]?.value || '';
        if (!jsonStr.trim()) {
            const msg = 'Chưa cấu hình Google Service Account Key JSON trong Admin CP.';
            await db.execute({
                sql: "INSERT INTO google_indexing_logs (id, url, action_type, status, response_message, created_at) VALUES (?, ?, ?, 'skipped', ?, ?)",
                args: [logId, targetUrl, actionType, msg, nowIso]
            });
            return { skipped: true, reason: msg };
        }

        const accessToken = await getGoogleAccessToken(jsonStr);

        const pushResp = await fetch('https://indexing.googleapis.com/v3/urlNotifications:publish', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                url: targetUrl,
                type: actionType
            })
        });

        const pushData = await pushResp.json();
        const ok = pushResp.ok && !pushData.error;
        const statusStr = ok ? 'success' : 'error';
        const msgStr = ok ? `Đã nộp thành công lúc ${new Date(pushData.urlNotificationMetadata?.latestUpdate?.notifyTime || Date.now()).toLocaleTimeString('vi-VN')}` : (pushData.error?.message || pushResp.statusText);

        await db.execute({
            sql: "INSERT INTO google_indexing_logs (id, url, action_type, status, response_message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            args: [logId, targetUrl, actionType, statusStr, msgStr, nowIso]
        });

        // Tự động cập nhật indexed_at vào cơ sở dữ liệu nếu nộp Google thành công
        if (ok) {
            try {
                if (blogId) {
                    await db.execute({ sql: "UPDATE blog_posts SET indexed_at = ? WHERE id = ?", args: [nowIso, blogId] });
                }
                if (targetUrl.includes('/blog/')) {
                    const rawSlug = targetUrl.split('/blog/')[1].split('?')[0].split('#')[0];
                    const slugWithPrefix = '/blog/' + rawSlug;
                    await db.execute({
                        sql: "UPDATE blog_posts SET indexed_at = ? WHERE slug = ? OR slug = ? OR id = ? OR slug LIKE ?",
                        args: [nowIso, rawSlug, slugWithPrefix, rawSlug, `%${rawSlug}%`]
                    });
                }
            } catch(updateErr) {
                console.error('[AUTO-UPDATE INDEXED_AT ERROR]', updateErr.message);
            }
        }

        console.log(`[GOOGLE INDEXING API ${statusStr.toUpperCase()}] ${targetUrl} -> ${msgStr}`);
        return { success: ok, status: statusStr, message: msgStr, data: pushData };
    } catch(e) {
        console.error('[GOOGLE INDEXING API ERROR]', e.message);
        try {
            await db.execute({
                sql: "INSERT INTO google_indexing_logs (id, url, action_type, status, response_message, created_at) VALUES (?, ?, ?, 'error', ?, ?)",
                args: [logId, targetUrl, actionType, e.message, nowIso]
            });
        } catch(err) {}
        return { error: e.message };
    }
}

app.get('/api/admin/seo/indexing-config', authenticateToken, async (req, res) => {
    try {
        const keyRes = await db.execute("SELECT value FROM settings WHERE key = 'googleServiceAccountJson'");
        const jsonStr = keyRes.rows?.[0]?.value || '';
        
        let logsRes = { rows: [] };
        try {
            logsRes = await db.execute("SELECT * FROM google_indexing_logs ORDER BY created_at DESC LIMIT 15");
        } catch(e) {}

        res.json({
            hasKey: Boolean(jsonStr.trim()),
            serviceAccountJson: jsonStr,
            logs: logsRes.rows || []
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/seo/indexing-config', authenticateToken, async (req, res) => {
    try {
        const { serviceAccountJson } = req.body;
        const val = typeof serviceAccountJson === 'string' ? serviceAccountJson.trim() : JSON.stringify(serviceAccountJson);

        if (val) {
            try { JSON.parse(val); } catch(e) {
                return res.status(400).json({ error: 'Nội dung JSON Service Account Key không đúng định dạng JSON hợp lệ!' });
            }
        }

        await db.execute({
            sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('googleServiceAccountJson', ?)",
            args: [val]
        });

        res.json({ success: true, message: 'Đã lưu cấu hình Google Indexing Service Account Key thành công!' });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/seo/indexing-posts', authenticateToken, async (req, res) => {
    try {
        try {
            await db.execute("ALTER TABLE blog_posts ADD COLUMN indexed_at TEXT DEFAULT ''");
            await db.execute("ALTER TABLE blog_posts ADD COLUMN telegram_shared_at TEXT DEFAULT ''");
        } catch(e) {}

        const postsRes = await db.execute("SELECT * FROM blog_posts ORDER BY created_at DESC LIMIT 50");
        
        let logsMap = {};
        try {
            const logsRes = await db.execute("SELECT url, created_at FROM google_indexing_logs WHERE status = 'success' ORDER BY created_at ASC");
            (logsRes.rows || []).forEach(l => {
                const u = String(l.url || '');
                if (u) logsMap[u] = l.created_at;
            });
        } catch(e) {}

        const posts = (postsRes.rows || []).map(r => {
            const cleanSlug = String(r.slug || '').replace(/^\/blog\//, '');
            const rawSlug = String(r.slug || '');
            let idxTime = r.indexed_at || '';

            if (!idxTime) {
                for (const urlKey in logsMap) {
                    if (cleanSlug && urlKey.includes(cleanSlug)) {
                        idxTime = logsMap[urlKey];
                    } else if (rawSlug && urlKey.includes(rawSlug)) {
                        idxTime = logsMap[urlKey];
                    } else if (r.id && urlKey.includes(r.id)) {
                        idxTime = logsMap[urlKey];
                    }
                }
            }

            return {
                id: r.id,
                title: r.title,
                slug: cleanSlug,
                status: r.status || 'draft',
                created_at: r.created_at,
                indexed_at: idxTime,
                telegram_shared_at: r.telegram_shared_at || ''
            };
        });

        res.json({ posts });
    } catch(e) {
        console.error('[INDEXING POSTS API ERROR]', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/seo/google-index-now', authenticateToken, async (req, res) => {
    try {
        const { targetUrl, blogId } = req.body;
        if (!targetUrl || !targetUrl.startsWith('http')) {
            return res.status(400).json({ error: 'URL nộp Google Indexing không hợp lệ (phải bắt đầu bằng http:// hoặc https://)!' });
        }

        const result = await pushToGoogleIndexingApi(targetUrl.trim());
        if (result.error) return res.status(400).json({ error: result.error });

        const nowIso = new Date().toISOString();
        try {
            if (blogId) {
                await db.execute({ sql: "UPDATE blog_posts SET indexed_at = ? WHERE id = ?", args: [nowIso, blogId] });
            }
            if (targetUrl.includes('/blog/')) {
                const rawSlug = targetUrl.split('/blog/')[1].split('?')[0].split('#')[0];
                const slugWithPrefix = '/blog/' + rawSlug;
                await db.execute({
                    sql: "UPDATE blog_posts SET indexed_at = ? WHERE slug = ? OR slug = ? OR id = ? OR slug LIKE ?",
                    args: [nowIso, rawSlug, slugWithPrefix, rawSlug, `%${rawSlug}%`]
                });
            }
        } catch(err) {
            console.error('[UPDATE INDEXED_AT ERROR]', err);
        }

        res.json(result);
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// 9.6 ADMIN: AUTO-BLOG SCHEDULER & CRON WORKER
app.get('/api/admin/blog/auto-config', authenticateToken, async (req, res) => {
    try {
        const result = await db.execute("SELECT key, value FROM settings WHERE key IN ('autoBlogSchedule', 'autoBlogAutoSuggest', 'autoBlogAutoPublish', 'autoBlogLastRun', 'autoBlogSuggestPrompt', 'autoBlogPostPrompt')");
        const configMap = {};
        (result.rows || []).forEach(r => { configMap[r.key] = r.value; });

        const schedule = configMap['autoBlogSchedule'] || 'off';
        const lastRunStr = configMap['autoBlogLastRun'] || '';

        // Compute next run time
        let nextRun = '';
        if (schedule !== 'off') {
            const intervalMsMap = { '8h': 8 * 3600000, '12h': 12 * 3600000, '24h': 24 * 3600000 };
            const ms = intervalMsMap[schedule] || 24 * 3600000;
            const baseTime = lastRunStr ? new Date(lastRunStr).getTime() : Date.now();
            nextRun = new Date(baseTime + ms).toISOString();
        }

        // Fetch 3 most recent posts
        const recentRes = await db.execute("SELECT id, title, slug, status, cover_image, created_at FROM blog_posts ORDER BY created_at DESC LIMIT 3");

        // Fetch stats
        const statsRes = await db.execute("SELECT status, COUNT(*) as count FROM blog_posts GROUP BY status");
        let totalPosts = 0, publishedPosts = 0, draftPosts = 0;
        (statsRes.rows || []).forEach(r => {
            const c = Number(r.count || 0);
            totalPosts += c;
            if (r.status === 'published') publishedPosts += c;
            else draftPosts += c;
        });

        // Count pending keywords
        const kwCountRes = await db.execute("SELECT COUNT(*) as count FROM seo_keywords WHERE status = 'pending' OR status IS NULL OR status = '' OR status != 'generated'");
        const pendingKeywordsCount = Number(kwCountRes.rows?.[0]?.count || 0);

        res.json({
            schedule,
            autoSuggest: configMap['autoBlogAutoSuggest'] !== 'false',
            autoPublish: configMap['autoBlogAutoPublish'] !== 'false',
            customSuggestPrompt: configMap['autoBlogSuggestPrompt'] || '',
            customPostPrompt: configMap['autoBlogPostPrompt'] || '',
            lastRun: lastRunStr,
            nextRun,
            recentPosts: recentRes.rows || [],
            pendingKeywordsCount,
            stats: { totalPosts, publishedPosts, draftPosts }
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/admin/blog/auto-config', authenticateToken, async (req, res) => {
    try {
        const { schedule, autoSuggest, autoPublish, customSuggestPrompt, customPostPrompt } = req.body;
        const validSchedules = ['off', '8h', '12h', '24h'];
        const schedVal = validSchedules.includes(schedule) ? schedule : 'off';
        const suggestVal = autoSuggest ? 'true' : 'false';
        const publishVal = autoPublish ? 'true' : 'false';

        await db.executeBatch([
            { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('autoBlogSchedule', ?)", args: [schedVal] },
            { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('autoBlogAutoSuggest', ?)", args: [suggestVal] },
            { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('autoBlogAutoPublish', ?)", args: [publishVal] },
            { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('autoBlogSuggestPrompt', ?)", args: [customSuggestPrompt || ''] },
            { sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('autoBlogPostPrompt', ?)", args: [customPostPrompt || ''] }
        ]);

        res.json({ success: true, schedule: schedVal, autoSuggest: suggestVal === 'true', autoPublish: publishVal === 'true' });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

let isAutoBlogRunning = false;

async function executeAutoBlogCycle(host = 'thohong.top') {
    if (isAutoBlogRunning) return { skipped: true, reason: 'Already running' };
    isAutoBlogRunning = true;

    try {
        const settingsResult = await db.execute("SELECT key, value FROM settings WHERE key IN ('deepseekApiKey', 'storeName', 'autoBlogAutoSuggest', 'autoBlogAutoPublish', 'autoBlogSuggestPrompt', 'autoBlogPostPrompt')");
        const settingsMap = {};
        (settingsResult.rows || []).forEach(r => { settingsMap[r.key] = r.value; });

        const apiKey = settingsMap['deepseekApiKey'];
        if (!apiKey) return { error: 'Chưa cấu hình DeepSeek API Key trong Admin Settings.' };

        const storeName = settingsMap['storeName'] || 'Thỏ Hồng / ĐHTK';
        const autoSuggest = settingsMap['autoBlogAutoSuggest'] !== 'false';
        const autoPublish = settingsMap['autoBlogAutoPublish'] !== 'false';

        // 0. Ensure table exists
        await db.execute(`CREATE TABLE IF NOT EXISTS seo_keywords (id TEXT PRIMARY KEY, keyword TEXT NOT NULL UNIQUE, difficulty TEXT DEFAULT 'Trung bình', reason TEXT DEFAULT '', status TEXT DEFAULT 'pending', created_at TEXT NOT NULL)`);

        // BƯỚC 1: Quét xem còn từ khóa trong hàng đợi hay không
        let kwResult = await db.execute("SELECT id, keyword, status FROM seo_keywords WHERE status = 'pending' OR status IS NULL OR status = '' OR status != 'generated' ORDER BY created_at ASC LIMIT 1");
        let kwRow = kwResult.rows?.[0];

        // BƯỚC 2: Nếu đã hết từ khóa trong danh sách đợi -> Tự động kích hoạt AI Gợi Ý & Thêm Hàng Đợi (nạp 10 từ khóa mới)
        if (!kwRow) {
            console.log('[AUTO-BLOG BƯỚC 2] Hàng đợi rỗng! Đang tự động gọi AI DeepSeek gợi ý 10 từ khóa mới...');
            const productsResult = await db.execute("SELECT DISTINCT category FROM products WHERE status = 'active' OR status IS NULL OR status = '' LIMIT 30");
            const categories = (productsResult.rows || []).map(r => r.category).filter(Boolean);

            let suggestPrompt = settingsMap['autoBlogSuggestPrompt'] || '';
            if (!suggestPrompt.trim()) {
                suggestPrompt = `Bạn là chuyên gia SEO hàng đầu cho website e-commerce Việt Nam.
Cửa hàng "${storeName}" chuyên kinh doanh các nhóm ngành hàng: ${categories.join(', ')}.
Hãy gợi ý 10 từ khóa SEO tiềm năng nhất cho blog của cửa hàng.
Trả về kết quả duy nhất 1 mảng JSON array: [{"keyword": "...", "reason": "...", "difficulty": "Dễ|Trung bình|Khó"}]`;
            } else {
                suggestPrompt = suggestPrompt.replace(/\${storeName}/g, storeName).replace(/\${categories}/g, categories.join(', '));
            }

            try {
                const sugResp = await fetch('https://api.deepseek.com/chat/completions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: suggestPrompt }], temperature: 0.7 })
                });
                const sugData = await sugResp.json();
                const text = sugData.choices?.[0]?.message?.content || '[]';
                const jsonMatch = text.match(/\[[\s\S]*\]/);
                const keywords = jsonMatch ? JSON.parse(jsonMatch[0]) : [];

                const now = new Date().toISOString();
                for (const k of keywords) {
                    if (k.keyword) {
                        const kwId = 'kw_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
                        try {
                            await db.execute({
                                sql: "INSERT OR IGNORE INTO seo_keywords (id, keyword, difficulty, reason, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)",
                                args: [kwId, k.keyword.trim(), k.difficulty || 'Trung bình', k.reason || '', now]
                            });
                        } catch(err) {}
                    }
                }

                // Re-query keyword from queue
                kwResult = await db.execute("SELECT id, keyword, status FROM seo_keywords WHERE status = 'pending' OR status IS NULL OR status = '' OR status != 'generated' ORDER BY created_at ASC LIMIT 1");
                kwRow = kwResult.rows?.[0];
            } catch(e) {
                console.error('[AUTO-BLOG SUGGEST ERROR]', e.message);
            }

            // Fast fallback keyword if AI suggestion didn't yield pending rows
            if (!kwRow) {
                const catResult = await db.execute("SELECT DISTINCT category FROM products WHERE category IS NOT NULL AND category != '' ORDER BY RANDOM() LIMIT 3");
                const cats = (catResult.rows || []).map(r => r.category).filter(Boolean);
                const chosenCat = cats[0] || 'Văn phòng phẩm';

                const generatedKw = `Kinh nghiệm chọn mua ${chosenCat} sỉ lẻ chất lượng cao`;
                const kwId = 'kw_' + Date.now();
                const now = new Date().toISOString();

                try {
                    await db.execute({
                        sql: "INSERT OR IGNORE INTO seo_keywords (id, keyword, difficulty, reason, status, created_at) VALUES (?, ?, 'Trung bình', 'Tự động tạo từ ngành hàng', 'pending', ?)",
                        args: [kwId, generatedKw, now]
                    });
                } catch(e) {}

                kwRow = { id: kwId, keyword: generatedKw };
            }
        }

        if (!kwRow) {
            return { error: 'Hàng đợi từ khóa đang rỗng. Vui lòng bật "Tự động AI Gợi Ý" hoặc thêm từ khóa mới.' };
        }

        const keyword = kwRow.keyword;
        const keywordId = kwRow.id;
        const protocol = 'https';
        const baseUrl = `${protocol}://${host}`;

        // 3. Fetch products and product images for AI prompt
        const prodResult = await db.execute("SELECT id, name, category, price, imageUrl, details FROM products WHERE (status = 'active' OR status IS NULL OR status = '') AND imageUrl IS NOT NULL AND imageUrl != '' LIMIT 15");
        
        const availableImages = [];
        const productsList = prodResult.rows.map(p => {
            const nameSlug = toAsciiSlug(p.name || '');
            const cleanId = String(p.id || '').replace(/^SP/i, '');
            const link = `${baseUrl}/san-pham/${encodeURIComponent(nameSlug)}-p${cleanId}`;
            
            const pImgs = [];
            if (p.imageUrl) {
                const fullUrl = p.imageUrl.startsWith('http') ? p.imageUrl : `${baseUrl}${p.imageUrl.startsWith('/') ? '' : '/'}${p.imageUrl}`;
                pImgs.push(fullUrl);
            }
            try {
                if (p.details) {
                    const parsed = JSON.parse(p.details);
                    if (Array.isArray(parsed.images)) {
                        parsed.images.forEach(img => {
                            if (img && typeof img === 'string') {
                                const fullUrl = img.startsWith('http') ? img : `${baseUrl}${img.startsWith('/') ? '' : '/'}${img}`;
                                if (!pImgs.includes(fullUrl)) pImgs.push(fullUrl);
                            }
                        });
                    }
                }
            } catch(e) {}

            pImgs.forEach(imgUrl => {
                if (!availableImages.some(i => i.url === imgUrl) && availableImages.length < 12) {
                    availableImages.push({ url: imgUrl, productName: p.name });
                }
            });

            return `- [${p.name}](${link}) (Giá: ${p.price ? p.price + 'đ' : 'Liên hệ'})`;
        }).join('\n');

        const imagesListPrompt = availableImages.length > 0
            ? availableImages.map((img, idx) => `Ảnh ${idx + 1}: ${img.url} (Sản phẩm: ${img.productName})`).join('\n')
            : 'Không có danh sách hình ảnh.';

        let prompt = settingsMap['autoBlogPostPrompt'] || '';
        if (!prompt.trim()) {
            prompt = `Bạn là nhà báo chuyên nghiệp và chuyên gia SEO thương mại điện tử Việt Nam.
Hãy viết 1 bài blog chất lượng cao chuẩn SEO cho cửa hàng "${storeName}" dựa trên từ khóa chính: "${keyword}".

DANH SÁCH SẢN PHẨM HIỆN CÓ TẠI CỬA HÀNG ĐỂ CHÈN INTERNAL LINK:
${productsList || 'Không có danh sách sản phẩm cụ thể.'}

DANH SÁCH HÌNH ẢNH SẢN PHẨM KHẢ DỤNG ĐỂ CHÈN VÀO BÀI VIẾT:
${imagesListPrompt}

YÊU CẦU SEO CHI TIẾT:
1. ĐỘ DÀI & ĐOẠN VĂN: Bài viết từ 1000 - 1500 từ. Chia thành các đoạn văn từ 3-4 câu giúp người đọc dễ theo dõi trên di động.
2. THẺ HEADING: Tiêu đề H1 chứa từ khóa chính, 3-5 thẻ H2 (##) và H3 (###).
3. MẬT ĐỘ TỪ KHÓA: Từ khóa "${keyword}" xuất hiện 3-5 lần một cách tự nhiên.
4. CHÈN INTERNAL LINK SẢN PHẨM: Bắt buộc chọn 2-3 sản phẩm phù hợp nhất và chèn ĐÚNG NGUYÊN VẸN cú pháp Markdown link: [Tên sản phẩm](Link) được cấp ở trên.
5. CHÈN 3 HÌNH ẢNH SẢN PHẨM VÀO BÀI VIẾT (BẮT BUỘC): Bắt buộc lấy đúng 3 URL hình ảnh từ danh sách hình ảnh khả dụng ở trên và chèn rải rác vào bài viết bằng cú pháp Markdown: \`![Mô tả ảnh sinh động chứa từ khóa SEO](URL_ảnh)\`. KHÔNG TỰ BỊA LINK ẢNH KHÁC.
6. ĐỊNH DẠNG MARKDOWN: Dùng **in đậm**, gạch đầu dòng (-).
7. LỜI KÊU GỌI HÀNG (CTA): Đoạn cuối kết bài kêu gọi khách hàng mua hàng tại ${storeName}.

ĐỊNH DẠNG TRẢ VỀ BẮT BUỘC:
##TITLE##
[Viết tiêu đề bài viết hấp dẫn, chứa từ khóa, dưới 65 ký tự]
##SUMMARY##
[Viết đoạn tóm tắt Meta Description chuẩn SEO từ 120-150 ký tự chứa từ khóa]
##CONTENT##
[Nội dung bài viết chi tiết bằng định dạng Markdown chứa 3 hình ảnh sản phẩm]`;
        } else {
            prompt = prompt
                .replace(/\${storeName}/g, storeName)
                .replace(/\${keyword}/g, keyword)
                .replace(/\${productsList}/g, productsList || 'Không có danh sách sản phẩm cụ thể.')
                .replace(/\${imagesListPrompt}/g, imagesListPrompt);
        }

        let response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.7 })
        });
        let data = await response.json();
        if (data.error) {
            response = await fetch('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.7 })
            });
            data = await response.json();
            if (data.error) return { error: data.error.message || 'DeepSeek API Error' };
        }

        const text = data.choices?.[0]?.message?.content || '';
        const titleMatch = text.match(/##TITLE##\s*(.*?)(?=##SUMMARY##)/s);
        const summaryMatch = text.match(/##SUMMARY##\s*(.*?)(?=##CONTENT##)/s);
        const contentMatch = text.match(/##CONTENT##\s*([\s\S]*)/);

        const title = titleMatch ? titleMatch[1].trim() : `${keyword} - Hướng dẫn chi tiết`;
        const summary = summaryMatch ? summaryMatch[1].trim().substring(0, 160) : '';
        const content = contentMatch ? contentMatch[1].trim() : text;

        let coverImage = '';
        const firstImgMatch = content.match(/!\[.*?\]\((https?:\/\/[^\s\)]+)\)/);
        if (firstImgMatch) {
            coverImage = firstImgMatch[1];
        } else if (availableImages.length > 0) {
            coverImage = availableImages[0].url;
        }

        const rawSlug = toAsciiSlug(title);
        const uniqueSlug = `${rawSlug}-${Date.now().toString(36)}`;
        const blogId = 'blog_' + Date.now();
        const nowIso = new Date().toISOString();
        const status = autoPublish ? 'published' : 'draft';

        await db.execute({
            sql: `INSERT INTO blog_posts (id, title, slug, summary, content, keyword, cover_image, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [blogId, title, uniqueSlug, summary, content, keyword, coverImage, status, nowIso, nowIso]
        });

        await db.execute({ sql: "UPDATE seo_keywords SET status = 'generated' WHERE id = ? OR keyword = ?", args: [keywordId || '', keyword] });
        await db.execute({ sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('autoBlogLastRun', ?)", args: [nowIso] });

        // Auto Push to Google Indexing API & Auto Share to Telegram Blog Channel
        if (status === 'published') {
            const fullBlogUrl = `${baseUrl}/blog/${uniqueSlug}`;
            try {
                await pushToGoogleIndexingApi(fullBlogUrl, 'URL_UPDATED', blogId);
                await shareBlogToTelegram(fullBlogUrl, title, summary, coverImage, blogId);
            } catch(e) {
                console.error('[AUTO-INDEX/TELEGRAM HOOK ERROR]', e.message);
            }
        }

        Object.keys(ssrSeoCache).forEach(k => { if (k.startsWith('blog_')) delete ssrSeoCache[k]; });

        console.log(`[AUTO-BLOG SUCCESS] Auto published post: "${title}" (Slug: /blog/${uniqueSlug})`);
        return { success: true, title, slug: uniqueSlug, status };
    } catch(e) {
        console.error('[AUTO-BLOG ERROR]', e.message);
        return { error: e.message };
    } finally {
        isAutoBlogRunning = false;
    }
}

app.post('/api/admin/blog/auto-trigger', authenticateToken, async (req, res) => {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'thohong.top';
    const result = await executeAutoBlogCycle(host);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
});

// 9.7 PUBLIC CRON ENDPOINT FOR AUTO-BLOG (Compatible with cron-job.org & Vercel)
app.all('/api/cron/auto-blog', async (req, res) => {
    try {
        const result = await db.execute("SELECT key, value FROM settings WHERE key IN ('autoBlogSchedule', 'autoBlogLastRun')");
        const configMap = {};
        (result.rows || []).forEach(r => { configMap[r.key] = r.value; });

        const schedule = configMap['autoBlogSchedule'] || 'off';
        if (schedule === 'off') {
            return res.json({ status: 'skipped', reason: 'Tự động viết bài đang TẮT (Schedule is off in Admin CP)' });
        }

        const intervalMsMap = {
            '8h': 8 * 3600000,
            '12h': 12 * 3600000,
            '24h': 24 * 3600000
        };
        const targetInterval = intervalMsMap[schedule] || 8 * 3600000;

        const lastRunStr = configMap['autoBlogLastRun'] || '';
        const lastRunTime = lastRunStr ? new Date(lastRunStr).getTime() : 0;
        const now = Date.now();
        const elapsed = now - lastRunTime;

        if (elapsed < targetInterval) {
            const remainingMs = targetInterval - elapsed;
            const remainingHours = (remainingMs / 3600000).toFixed(1);
            return res.json({
                status: 'waiting',
                schedule,
                lastRun: lastRunStr,
                message: `Chưa đến chu kỳ ${schedule}. Lần chạy gần nhất: ${lastRunStr || 'Chưa chạy'}. Cần đợi thêm ~${remainingHours} giờ.`
            });
        }

        // Đã đến chu kỳ -> Thực thi viết bài tự động
        console.log(`[EXTERNAL CRON /api/cron/auto-blog] Triggering auto-blog cycle (Schedule: ${schedule})...`);
        const host = req.headers['x-forwarded-host'] || req.headers.host || 'thohong.top';
        const execResult = await executeAutoBlogCycle(host);

        if (execResult.error) {
            return res.status(500).json({ status: 'error', error: execResult.error });
        }

        res.json({
            status: 'success',
            schedule,
            execResult
        });
    } catch(e) {
        console.error('[CRON AUTO-BLOG ROUTE ERROR]', e.message);
        res.status(500).json({ status: 'error', error: e.message });
    }
});


// Periodic Cron check loop (Runs every 10 minutes to see if schedule interval has elapsed)
setInterval(async () => {
    try {
        const result = await db.execute("SELECT key, value FROM settings WHERE key IN ('autoBlogSchedule', 'autoBlogLastRun')");
        const configMap = {};
        (result.rows || []).forEach(r => { configMap[r.key] = r.value; });

        const schedule = configMap['autoBlogSchedule'] || 'off';
        if (schedule === 'off') return;

        const intervalMsMap = {
            '8h': 8 * 60 * 60 * 1000,
            '12h': 12 * 60 * 60 * 1000,
            '24h': 24 * 60 * 60 * 1000
        };
        const targetInterval = intervalMsMap[schedule];
        if (!targetInterval) return;

        const lastRunStr = configMap['autoBlogLastRun'] || '';
        const lastRunTime = lastRunStr ? new Date(lastRunStr).getTime() : 0;
        const now = Date.now();

        if (now - lastRunTime >= targetInterval) {
            console.log(`[AUTO-BLOG CRON] Scheduled time reached (${schedule}). Executing auto-blog cycle...`);
            await executeAutoBlogCycle('thohong.top');
        }
    } catch(e) {
        console.error('[AUTO-BLOG CRON ERROR]', e.message);
    }
}, 10 * 60 * 1000);

const slugifyVietnamese = (str) => {
    if (!str) return '';
    return String(str)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[đĐ]/g, 'd')
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
};

// DYNAMIC XML SITEMAP GENERATOR (FETCHES ALL PRODUCTS & CATEGORIES FROM TURSO DB)
app.get('/sitemap.xml', async (req, res) => {
    try {
        const host = req.headers['x-forwarded-host'] || req.headers.host || 'thohong.top';
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const baseUrl = `${protocol}://${host}`;
        const today = new Date().toISOString().split('T')[0];

        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
        xml += `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
        
        xml += `  <url>\n    <loc>${baseUrl}/</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>\n`;
        xml += `  <url>\n    <loc>${baseUrl}/dia-chi</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.9</priority>\n  </url>\n`;
        xml += `  <url>\n    <loc>${baseUrl}/lien-he</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.9</priority>\n  </url>\n`;

        const result = await db.execute("SELECT id, name, category, status FROM products WHERE status = 'active' OR status IS NULL OR status = ''");
        const rows = result.rows || [];

        const categories = new Set();
        rows.forEach(r => {
            if (r.category && r.category.trim()) categories.add(r.category.trim());
        });

        categories.forEach(cat => {
            const catSlug = slugifyVietnamese(cat);
            if (catSlug) {
                const catUrl = `${baseUrl}/danh-muc/${catSlug}`;
                xml += `  <url>\n    <loc>${catUrl}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
            }
        });

        rows.forEach(r => {
            const pId = r.id;
            const pName = r.name || 'san-pham';
            const nameSlug = slugifyVietnamese(pName) || 'san-pham';
            const prodUrl = `${baseUrl}/san-pham/${nameSlug}-p${pId}`;
            xml += `  <url>\n    <loc>${prodUrl}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.9</priority>\n  </url>\n`;
        });

        // Add published Blog posts to Sitemap
        const blogResult = await db.execute("SELECT slug, updated_at FROM blog_posts WHERE status = 'published' ORDER BY created_at DESC");
        const blogRows = blogResult.rows || [];
        blogRows.forEach(b => {
            const rawSlug = b.slug?.value || b.slug || '';
            const blogSlug = slugifyVietnamese(rawSlug) || rawSlug;
            if (blogSlug) {
                const blogUrl = `${baseUrl}/blog/${blogSlug}`;
                const lastmod = (b.updated_at?.value || b.updated_at || today).split('T')[0];
                xml += `  <url>\n    <loc>${blogUrl}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
            }
        });

        xml += `</urlset>`;

        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        return res.send(xml);
    } catch(err) {
        console.error('[DYNAMIC SITEMAP ERROR]', err.message);
        const host = req.headers['x-forwarded-host'] || req.headers.host || 'thohong.top';
        const today = new Date().toISOString().split('T')[0];
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        return res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${host}/</loc><lastmod>${today}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url></urlset>`);
    }
});

// 15. SEO SERVER-SIDE RENDERING FOR CATEGORIES & PRODUCTS (ZALO / FB SHARE PREVIEW)
const escapeHtmlServer = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ssrSeoCache = {}; // Memory cache for warm starts

app.use(async (req, res, next) => {
    const fullPath = req.headers['x-matched-path'] || req.originalUrl || req.url || '';
    if (req.path.startsWith('/api/') || req.url.startsWith('/api/') || fullPath.includes('/api/')) return next();

    const isCat = req.query.seo_type === 'cat' || fullPath.includes('/danh-muc/');
    const isProd = req.query.seo_type === 'prod' || fullPath.includes('/san-pham/');
    const isBlog = req.query.seo_type === 'blog' || fullPath === '/blog' || fullPath.includes('/blog/');

    if (!isCat && !isProd && !isBlog) return next();

    // Use cached HTML (no disk read on hot requests)
    const html = getCachedHtml();
    if (!html) {
        console.error('[SEO SSR WARN] Could not read public/index.html.');
        return next();
    }

    // Bot detection: Only trigger DB SSR for real social/search crawlers.
    // Real humans using Zalo/FB in-app browsers receive index.html instantly (<30ms).
    const userAgent = req.headers['user-agent'] || '';
    const isBot = /googlebot|bingbot|yandexbot|duckduckbot|slurp|baiduspider|facebookexternalhit|twitterbot|rogerbot|linkedinbot|embedly|quora link preview|showyoubot|outbrain|pinterestbot|slackbot|vkShare|W3C_Validator|whatsapp|zalo-bot|zalobot|telegrambot/i.test(userAgent);
    if (!isBot) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
    }

    let slug = req.query.seo_slug || '';
    if (!slug) {
        const parts = fullPath.split('?')[0].split('/');
        slug = parts[parts.length - 1] || parts[parts.length - 2] || '';
    }

    const cacheKey = `${isCat ? 'cat' : isBlog ? 'blog' : 'prod'}_${slug}`;

    let title = 'Tổng Kho Sỉ Lẻ Thỏ Hồng - Hệ Thống Đặt Hàng Thông Minh';
    let desc = 'Hệ thống đặt hàng sỉ lẻ thông minh Thỏ Hồng / ĐHTK, tự động tính toán chiết khấu, đồng bộ tồn kho POS trực tuyến.';
    let image = 'https://thohong.top/media__1784598666512.png';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'thohong.top';
    const protocol = req.headers['x-forwarded-proto'] || 'https';
    const fullUrl = `${protocol}://${host}${fullPath}`;
    let blogPostObj = null;

    if (ssrSeoCache[cacheKey]) {
        const c = ssrSeoCache[cacheKey];
        title = c.title || title;
        desc = c.desc || desc;
        image = c.image || image;
        if (c.blogPostObj) blogPostObj = c.blogPostObj;
    } else {
        try {
            const DB_TIMEOUT = 3500;
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('DB_TIMEOUT')), DB_TIMEOUT));

            const dbQueryPromise = (async () => {
                const decodedSlug = decodeURIComponent(slug);
                let storeName = 'Thỏ Hồng';

                if (isBlog) {
                    const batchRes = await db.executeBatch([
                        { sql: "SELECT key, value FROM settings WHERE key IN ('storeName')", args: [] },
                        { sql: "SELECT title, summary, content, cover_image, created_at, updated_at FROM blog_posts WHERE slug = ? OR slug = ? OR id = ? LIMIT 1", args: [slug, decodedSlug, decodedSlug] }
                    ]);
                    const settingsRows = batchRes.results?.[0]?.response?.result?.rows || [];
                    settingsRows.forEach(r => { if (r[0]?.value === 'storeName') storeName = r[1]?.value || storeName; });

                    let blogRows = batchRes.results?.[1]?.response?.result?.rows || [];
                    if (blogRows.length === 0) {
                        const fbRes = await db.execute({
                            sql: "SELECT title, summary, content, cover_image, created_at, updated_at FROM blog_posts WHERE slug LIKE ? LIMIT 1",
                            args: [`%${decodedSlug}%`]
                        });
                        blogRows = fbRes.rows || [];
                    }

                    if (blogRows.length > 0) {
                        const row = blogRows[0];
                        const bTitle = row.title || row[0]?.value || '';
                        const bSummary = row.summary || row[1]?.value || '';
                        const bContent = row.content || row[2]?.value || '';
                        const bCover = row.cover_image || row[3]?.value || '';
                        const bCreated = row.created_at || row[4]?.value || new Date().toISOString();
                        const bUpdated = row.updated_at || row[5]?.value || bCreated;

                        title = `${bTitle} | ${storeName}`;
                        desc = bSummary || bContent.replace(/[#*>\-\n]/g, ' ').substring(0, 160).trim();
                        if (bCover) image = bCover;
                        blogPostObj = { title: bTitle, desc, image, created: bCreated, updated: bUpdated };
                    }
                } else if (isCat) {
                    const rawCatName = decodedSlug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                    const batchRes = await db.executeBatch([
                        { sql: "SELECT key, value FROM settings WHERE key IN ('storeName')", args: [] },
                        { sql: "SELECT category, imageUrl, details FROM products WHERE LOWER(category) LIKE ? LIMIT 1", args: [`%${rawCatName.toLowerCase()}%`] }
                    ]);
                    const settingsRows = batchRes.results?.[0]?.response?.result?.rows || [];
                    settingsRows.forEach(r => { if (r[0]?.value === 'storeName') storeName = r[1]?.value || storeName; });

                    const catRows = batchRes.results?.[1]?.response?.result?.rows || [];
                    let realCatName = rawCatName;
                    if (catRows.length > 0) {
                        const catRow = catRows[0];
                        if (catRow[0]?.value) realCatName = catRow[0].value;
                        if (catRow[1]?.value) image = catRow[1].value;
                        else {
                            try {
                                const details = JSON.parse(catRow[2]?.value || '{}');
                                if (details.images?.[0]) image = details.images[0];
                            } catch(e) {}
                        }
                    }
                    title = `Danh Mục ${realCatName} | ${storeName}`;
                    desc = `Tổng hợp sản phẩm danh mục ${realCatName} tại ${storeName}. Giá sỉ/lẻ tốt nhất, chiết khấu tự động theo số lượng.`;
                } else if (isProd) {
                    const pIdMatch = decodedSlug.match(/-p([a-zA-Z0-9_-]+)$/) || decodedSlug.match(/^p([a-zA-Z0-9_-]+)$/);
                    const rawPid = pIdMatch ? pIdMatch[1] : decodedSlug;
                    const cleanPid = rawPid.replace(/^SP/i, '');
                    const basePid = cleanPid.split('_')[0];
                    const possibleIds = Array.from(new Set([rawPid, cleanPid, basePid, `SP${cleanPid}`, `SP${basePid}`]));
                    const placeholders = possibleIds.map(() => '?').join(',');

                    const slugWithoutId = decodedSlug.replace(/-p[a-zA-Z0-9_-]+$/, '').trim();

                    const batchRes = await db.executeBatch([
                        { sql: "SELECT key, value FROM settings WHERE key IN ('storeName')", args: [] },
                        { sql: `SELECT id, name, price, imageUrl, details, description FROM products WHERE id IN (${placeholders}) LIMIT 1`, args: possibleIds },
                        { sql: "SELECT id, name, price, imageUrl, details, description FROM products WHERE status = 'active' OR status IS NULL OR status = '' LIMIT 50", args: [] }
                    ]);
                    const settingsRows = batchRes.results?.[0]?.response?.result?.rows || [];
                    settingsRows.forEach(r => { if (r[0]?.value === 'storeName') storeName = r[1]?.value || storeName; });

                    let prodRows = batchRes.results?.[1]?.response?.result?.rows || [];
                    if (prodRows.length === 0 && slugWithoutId) {
                        const allProds = batchRes.results?.[2]?.response?.result?.rows || [];
                        const foundRow = allProds.find(r => {
                            const pName = r[1]?.value || '';
                            const pSlug = toAsciiSlug(pName);
                            return pSlug === slugWithoutId || slugWithoutId.includes(pSlug) || pSlug.includes(slugWithoutId);
                        });
                        if (foundRow) prodRows = [foundRow];
                    }

                    if (prodRows.length > 0) {
                        const row = prodRows[0];
                        const pName = row[1]?.value || '';
                        const pPrice = parseInt(row[2]?.value || 0);
                        if (row[3]?.value) image = row[3].value;
                        else {
                            try {
                                const details = JSON.parse(row[4]?.value || '{}');
                                if (details.images?.[0]) image = details.images[0];
                            } catch(e) {}
                        }
                        const pDesc = row[5]?.value || '';
                        title = `${pName} | ${storeName}`;
                        const formatPrice = pPrice ? new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(pPrice) : 'Giá sỉ tốt nhất';
                        desc = `${pName} giá chỉ từ ${formatPrice}. ${pDesc || 'Hàng sẵn kho, giao nhanh, chiết khấu tự động.'}`.substring(0, 160);
                    } else {
                        title = `404 - Sản Phẩm Không Tồn Tại | ${storeName}`;
                        desc = `Sản phẩm bạn đang tìm kiếm không tồn tại hoặc đã bị gỡ tại ${storeName}.`;
                    }
                }

                // Save to Cache
                ssrSeoCache[cacheKey] = { title, desc, image, blogPostObj };
            })();

            await Promise.race([dbQueryPromise, timeoutPromise]);
        } catch(err) {
            if (err.message === 'DB_TIMEOUT') {
                console.warn('[SEO SSR] DB query timed out after 8.5s, serving static HTML fallback.');
            } else {
                console.error('[SEO SSR ERROR]', err.message);
            }
        }
    }

    // Inject dynamic Meta and Open Graph tags into HTML response
    let out = html
        .replace(/<title>.*?<\/title>/i, `<title>${escapeHtmlServer(title)}</title>`)
        .replace(/<meta name="description" id="seoDescription" content=".*?">/i, `<meta name="description" id="seoDescription" content="${escapeHtmlServer(desc)}">`)
        .replace(/<meta property="og:title" id="ogTitle" content=".*?">/i, `<meta property="og:title" id="ogTitle" content="${escapeHtmlServer(title)}">`)
        .replace(/<meta property="og:description" id="ogDescription" content=".*?">/i, `<meta property="og:description" id="ogDescription" content="${escapeHtmlServer(desc)}">`)
        .replace(/<meta property="og:image" id="ogImage" content=".*?">/i, `<meta property="og:image" id="ogImage" content="${escapeHtmlServer(image)}">`)
        .replace(/<meta property="og:url" id="ogUrl" content=".*?">/i, `<meta property="og:url" id="ogUrl" content="${escapeHtmlServer(fullUrl)}">`)
        .replace(/<meta name="twitter:title" id="twitterTitle" content=".*?">/i, `<meta name="twitter:title" id="twitterTitle" content="${escapeHtmlServer(title)}">`)
        .replace(/<meta name="twitter:description" id="twitterDescription" content=".*?">/i, `<meta name="twitter:description" id="twitterDescription" content="${escapeHtmlServer(desc)}">`)
        .replace(/<meta name="twitter:image" id="twitterImage" content=".*?">/i, `<meta name="twitter:image" id="twitterImage" content="${escapeHtmlServer(image)}">`);

    let ssrSchemaJson = '';
    if (isBlog && blogPostObj) {
        const blogObj = {
            "@context": "https://schema.org",
            "@type": "BlogPosting",
            "headline": blogPostObj.title,
            "description": blogPostObj.desc,
            "image": [blogPostObj.image],
            "datePublished": blogPostObj.created,
            "dateModified": blogPostObj.updated,
            "author": { "@type": "Organization", "name": title.split(' | ')[1] || "Thỏ Hồng" },
            "publisher": { "@type": "Organization", "name": title.split(' | ')[1] || "Thỏ Hồng" },
            "mainEntityOfPage": { "@type": "WebPage", "@id": fullUrl }
        };
        const bcObj = {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "itemListElement": [
                { "@type": "ListItem", "position": 1, "name": "Trang chủ", "item": `${protocol}://${host}/` },
                { "@type": "ListItem", "position": 2, "name": "Blog", "item": `${protocol}://${host}/blog` },
                { "@type": "ListItem", "position": 3, "name": blogPostObj.title, "item": fullUrl }
            ]
        };
        ssrSchemaJson = `<script type="application/ld+json">${JSON.stringify(blogObj)}</script>\n<script type="application/ld+json">${JSON.stringify(bcObj)}</script>\n`;
    } else if (isProd) {
        const prodObj = {
            "@context": "https://schema.org",
            "@type": "Product",
            "name": title.split(' | ')[0] || title,
            "image": [image],
            "description": desc,
            "offers": {
                "@type": "Offer",
                "priceCurrency": "VND",
                "price": 0,
                "availability": "https://schema.org/InStock",
                "url": fullUrl
            }
        };
        const bcObj = {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "itemListElement": [
                { "@type": "ListItem", "position": 1, "name": "Trang chủ", "item": `${protocol}://${host}/` },
                { "@type": "ListItem", "position": 2, "name": title.split(' | ')[0] || "Sản phẩm", "item": fullUrl }
            ]
        };
        ssrSchemaJson = `<script type="application/ld+json">${JSON.stringify(prodObj)}</script>\n<script type="application/ld+json">${JSON.stringify(bcObj)}</script>\n`;
    } else if (isCat) {
        const bcObj = {
            "@context": "https://schema.org",
            "@type": "BreadcrumbList",
            "itemListElement": [
                { "@type": "ListItem", "position": 1, "name": "Trang chủ", "item": `${protocol}://${host}/` },
                { "@type": "ListItem", "position": 2, "name": title.split(' | ')[0] || "Danh mục", "item": fullUrl }
            ]
        };
        ssrSchemaJson = `<script type="application/ld+json">${JSON.stringify(bcObj)}</script>\n`;
    }

    if (ssrSchemaJson) {
        out = out.replace('</head>', `${ssrSchemaJson}</head>`);
    }

    if (settings.customHeaderCode) {
        out = out.replace('</head>', `${settings.customHeaderCode}\n</head>`);
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(out);
});

// 16. SPA FALLBACK ROUTE (GUARANTEES 200 OK FOR ALL FRONTEND ROUTES)
app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    const possiblePaths = [
        path.join(process.cwd(), 'public', 'index.html'),
        path.join(__dirname, 'public', 'index.html'),
        path.join(__dirname, 'index.html')
    ];
    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            return res.sendFile(p);
        }
    }
    res.status(200).send('<!DOCTYPE html><html><head><title>Thỏ Hồng</title></head><body><div id="app"></div></body></html>');
});

// START EXPRESS SERVER OR EXPORT FOR VERCEL
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    initDB().catch(err => {
        console.warn('⚠️ Warning: DB Initialization (Turso Cloud):', err.message);
    }).finally(() => {
        app.listen(PORT, () => {
            console.log(`==================================================`);
            console.log(`🚀 SERVER RUNNING AT: http://localhost:${PORT}`);
            console.log(`🔑 Default Admin: admin | dhtk2024`);
            console.log(`==================================================`);
        });
    });
} else {
    // Trên Vercel: Bỏ qua initDB tự động để tránh 8 truy vấn lặp lại gây trễ cold start
    try { getCachedHtml(); } catch(e) {}
    console.log('[Vercel] Server ready. Direct CDN route active.');
}

module.exports = app;
// Trigger Vercel Build
