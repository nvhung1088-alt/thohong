require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
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
    'https://donghangtietkiem.com',
    'https://www.donghangtietkiem.com',
    'https://thohong.vercel.app',
    'https://thohong.top',
    'https://www.thohong.top',
    'http://localhost:3000'
];
app.use(cors({
    origin: (origin, callback) => {
        // Cho phep request khong co origin (Postman, curl, mobile app)
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error('CORS: Domain not allowed'));
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS']
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

const db = { 
    execute: (obj) => {
        if (typeof obj === 'string') return executeTurso(obj, []);
        return executeTurso(obj.sql, obj.args || []);
    }
};

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
            metaTitle: 'ĐHTK - Tổng Kho Sỉ Lẻ V12 (Bug Fix Data)',
            metaDescription: 'Hệ thống đặt hàng sỉ lẻ thông minh ĐHTK, tự động tính toán chiết khấu, đồng bộ tồn kho POS Pancake trực tuyến.',
            telegramToken: process.env.TELEGRAM_TOKEN || '',
            telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
            storeName: 'Tổng Kho ĐHTK',
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

    // Ensure last_pos_sync exists if DB was already seeded
    try {
        await db.execute("INSERT OR IGNORE INTO settings (key, value) VALUES ('last_pos_sync', '0')");
    } catch(e) {}

    // Seed default products if not exists
    const productsCountResult = await db.execute('SELECT COUNT(*) as count FROM products');
    const productsCount = productsCountResult.rows[0]?.count || 0;
    if (Number(productsCount) === 0) {
        const seedProducts = [
            { id: "1", name: "Băng dính trong 100 Yard", sku: "BD100Y", price: 12000, costPrice: 8000, imageUrl: "https://picsum.photos/200?random=1", category: "Băng dính", quantity: 150, status: "active", discountGroup: "Băng dính", details: "Độ dính cao, dai, không đứt quãng." },
            { id: "2", name: "Cuộn xốp hơi 50cm x 100m", sku: "CUONXOP50CMX100M", price: 150000, costPrice: 110000, imageUrl: "https://picsum.photos/200?random=2", category: "Xốp bọc hàng", quantity: 32, status: "active", discountGroup: "Màng xốp", details: "Chống va đập tốt, bóng khí dai." },
            { id: "3", name: "Hộp carton 10x10x10cm", sku: "CARTON10X10X10", price: 1500, costPrice: 900, imageUrl: "https://picsum.photos/200?random=3", category: "Hộp Carton", quantity: 1200, status: "active", discountGroup: "Hộp giấy", details: "Giấy 3 lớp sóng B cứng cáp." },
            { id: "4", name: "Màng PE quấn hàng 2.4kg", sku: "MANGPE2.4KG", price: 85000, costPrice: 65000, imageUrl: "https://picsum.photos/200?random=4", category: "Màng PE", quantity: 80, status: "active", discountGroup: "Màng PE", details: "Độ co giãn 350%, bám dính tốt." }
        ];

        for (const p of seedProducts) {
            await db.execute({
                sql: 'INSERT INTO products (id, name, sku, price, costPrice, imageUrl, category, quantity, status, discountGroup, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                args: [p.id, p.name, p.sku, p.price, p.costPrice, p.imageUrl, p.category, p.quantity, p.status, p.discountGroup, p.details]
            });
        }
        console.log('[DB] Seeding default products done.');
    }
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
        const publicKeys = ['bannerTitle', 'bannerSubtitle', 'logoText', 'metaTitle', 'metaDescription', 'storeName', 'contact_hotline', 'contact_zalo'];
        rows.forEach(r => {
            if (publicKeys.includes(r.key)) {
                settings[r.key] = r.value;
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
            await db.execute({
                sql: 'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
                args: [key, String(value)]
            });
        }
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
                description: details.description || ''
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
    const { products } = req.body;
    if (!Array.isArray(products)) return res.status(400).json({ error: 'Invalid products array' });

    try {
        await db.execute('DELETE FROM products');

        for (const p of products) {
            const detailsJson = JSON.stringify({
                images: p.images || [],
                pricingTiers: p.pricingTiers || [],
                options: p.options || [],
                variants: p.variants || [],
                description: p.description || ''
            });
            await db.execute({
                sql: `
                    INSERT INTO products 
                    (id, name, sku, price, costPrice, imageUrl, category, quantity, status, discountGroup, details) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `,
                args: [
                    String(p.id), p.name, p.sku || '', parseInt(p.price) || 0, parseInt(p.costPrice) || 0,
                    p.imageUrl || (p.images && p.images[0]) || '', p.category || '', parseInt(p.quantity) || 0,
                    p.status || 'active', p.discountGroup || '', detailsJson
                ]
            });
        }
        res.json({ success: true, count: products.length });
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

        const getTierPrice = (originalProduct, totalGroupQty) => {
            const price = originalProduct.price;
            if (totalGroupQty >= 100) return Math.round(price * 0.80);
            if (totalGroupQty >= 50) return Math.round(price * 0.85);
            if (totalGroupQty >= 20) return Math.round(price * 0.90);
            if (totalGroupQty >= 10) return Math.round(price * 0.95);
            return price;
        };

        let totalAmount = 0;
        let originalAmount = 0;
        const processedItems = [];

        items.forEach(item => {
            const originalProduct = productMap[item.id];
            if (!originalProduct) return;

            const group = originalProduct.discountGroup;
            const totalGroupQty = groupQuantities[group] || item.qty;
            const finalUnitPrice = originalProduct.discountGroup ? getTierPrice(originalProduct, totalGroupQty) : originalProduct.price;

            const itemTotal = finalUnitPrice * item.qty;
            const itemOriginalTotal = originalProduct.price * item.qty;

            totalAmount += itemTotal;
            originalAmount += itemOriginalTotal;

            processedItems.push({
                name: originalProduct.name,
                sku: originalProduct.sku,
                qty: item.qty,
                originalPrice: originalProduct.price,
                finalPrice: finalUnitPrice,
                total: itemTotal
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

        res.json({
            success: true,
            orderId: Date.now(),
            totalAmount,
            totalDiscount,
            telegramSent
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

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
        if (variations.length === 0) {
            const code = posProduct.code || posProduct.sku || posProduct.id;
            if (code) {
                skuStockMap[String(code).trim().toUpperCase()] = getStock(posProduct);
            }
        } else {
            variations.forEach(v => {
                const sku = v.code || v.sku || v.barcode;
                if (sku) {
                    skuStockMap[String(sku).trim().toUpperCase()] = getStock(v);
                }
            });
        }
    });

    const resultProducts = await db.execute('SELECT * FROM products');
    const dbProducts = resultProducts.rows;
    let updateCount = 0;
    const matchedProducts = [];
    const unmatchedProducts = [];

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
                const newStock = skuStockMap[parentSku];
                const oldStock = localProduct.quantity || 0;
                if (oldStock !== newStock) {
                    productQuantitySum = newStock;
                    isUpdated = true;
                    updateCount++;
                } else {
                    productQuantitySum = oldStock;
                }
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
                    const newStock = skuStockMap[skuKey];
                    const oldStock = v.stock || 0;
                    if (oldStock !== newStock) {
                        v.stock = newStock;
                        isUpdated = true;
                        updateCount++;
                    }
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
        }

        if (isUpdated) {
            details.variants = variants;
            await db.execute({
                sql: 'UPDATE products SET quantity = ?, details = ? WHERE id = ?',
                args: [productQuantitySum, JSON.stringify(details), localProduct.id]
            });
        }
    }

    await db.execute({
        sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('last_pos_sync', ?)",
        args: [String(Date.now())]
    });

    return {
        totalPosProducts: allPosProducts.length,
        matchedCount: updateCount,
        matchedProducts,
        unmatchedProducts
    };
}

// 10. PANCAKE POS PROXY SYNC (SECURE & ALIGNED WITH MOCKUP)

app.get('/api/pos/sync', (req, res, next) => {
    // Neu la request tu Vercel Cron: Vercel gui Authorization: Bearer <CRON_SECRET>
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'];
    
    console.log('[CRON_DEBUG] Request received:', {
        hasCronSecret: !!cronSecret,
        cronSecretLength: cronSecret ? cronSecret.length : 0,
        hasAuthHeader: !!authHeader,
        authHeaderValue: authHeader
    });

    if (cronSecret && authHeader === `Bearer ${cronSecret}`) {
        return next(); // Bypass JWT - day la Vercel Cron hop le
    }
    authenticateToken(req, res, next); // Nguoi dung Admin binh thuong
}, async (req, res) => {
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

// START EXPRESS SERVER OR EXPORT FOR VERCEL
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    initDB().then(() => {
        app.listen(PORT, () => {
            console.log(`==================================================`);
            console.log(`🚀 SERVER RUNNING AT: http://localhost:${PORT}`);
            console.log(`🔑 Default Admin: admin | dhtk2024`);
            console.log(`==================================================`);
        });
    }).catch(err => {
        console.error('Failed to initialize database:', err);
    });
} else {
    // Trên Vercel, chạy ngầm khởi tạo cấu trúc bảng (nếu cần)
    initDB().catch(err => console.error('Failed to init DB on Vercel:', err));
}

module.exports = app;
