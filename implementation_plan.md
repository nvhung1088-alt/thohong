# Plan: Migrate ĐHTK Store → Vercel + Turso SQLite Cloud

> Audit từ mã nguồn thực tế. Tổng thay đổi: **~80 dòng code** tập trung vào `server.js`.  
> Frontend `public/index.html` **KHÔNG cần chạm vào** bất kỳ dòng nào.

---

## Bối cảnh kiến trúc hiện tại vs. Vercel

| | Local / Render | Vercel |
|---|---|---|
| Máy chủ chạy | Express.js tiến trình liên tục | Serverless Functions (AWS Lambda) |
| Database | `dhtk_store.db` — file trên ổ đĩa | ❌ Không có ổ đĩa vĩnh viễn |
| Auto-sync ngầm | Chạy không giới hạn thời gian | ❌ Bị kill sau 10–15 giây |
| Static files | `express.static('public/')` | ✅ Vercel tự phục vụ qua CDN |
| Rate limiter | In-memory `orderRateLimit = {}` | ⚠️ Không tin cậy (nhiều instance) |

---

## Yêu cầu từ phía Người dùng (Manual Steps)

> ⚠️ Bước này **AI không làm thay được** — cần bạn tự thực hiện trên trình duyệt.

### Bước U1 — Đăng ký tài khoản Turso (3 phút)
1. Truy cập [https://turso.tech](https://turso.tech) → Sign up (miễn phí, dùng GitHub).
2. Tạo database mới: chọn tên (ví dụ: `dhtk-store`), chọn vùng gần nhất (Singapore).
3. Vào mục **Tokens** → tạo Token mới → copy lại.
4. Vào database vừa tạo → copy **Database URL** (dạng `libsql://dhtk-store-xxx.turso.io`).

**Bạn cần cung cấp cho AI 2 giá trị:**
```
TURSO_DATABASE_URL=libsql://dhtk-store-xxx.turso.io
TURSO_AUTH_TOKEN=eyJhbGciOiJFZERTQS...
```

### Bước U2 — Đẩy code lên GitHub (5 phút)
1. Tạo repository mới trên [github.com](https://github.com) (private).
2. `git init && git add . && git commit -m "initial"`.
3. `git remote add origin <url> && git push`.
> ⚠️ File `.env` và `dhtk_store.db` đã được `.gitignore` bảo vệ — sẽ không bị đẩy lên.

### Bước U3 — Deploy lên Vercel (5 phút)
1. Truy cập [vercel.com](https://vercel.com) → Import from GitHub → chọn repo.
2. Vercel tự nhận dạng là Node.js project.
3. Vào **Settings → Environment Variables** → nhập đủ các biến sau:
```
PORT=3000
JWT_SECRET=dhtk_super_secure_secret_key_2026
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=756fc18174c6b994c361b04c9f27a70867d675f7e402c355a9f5bf6b18f67390
PANCAKE_API_KEY=898c0e01aaad4d64bd77e9dcc3ee3e76
PANCAKE_SHOP_ID=430016713
PANCAKE_WAREHOUSE_ID=2e8695e7-078c-4c0a-8598-dacf05979ed1
TELEGRAM_TOKEN=<token của bạn>
TELEGRAM_CHAT_ID=-5452280680
TURSO_DATABASE_URL=<lấy từ Bước U1>
TURSO_AUTH_TOKEN=<lấy từ Bước U1>
```

---

## Các thay đổi Code (AI thực hiện)

---

### Thay đổi 1 — Cài package Turso client

Thay `sqlite3` + `sqlite` bằng `@libsql/client` (driver chính thức của Turso, tương thích hoàn toàn với SQLite syntax):

```bash
npm install @libsql/client
npm uninstall sqlite3 sqlite
```

---

### Thay đổi 2 — `server.js`: Đổi kết nối DB (dòng 1–25)

**Trước:**
```js
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
let db;
async function initDB() {
    db = await open({ filename: path.join(__dirname, 'dhtk_store.db'), driver: sqlite3.Database });
    ...
}
```

**Sau:**
```js
const { createClient } = require('@libsql/client');
let db;
async function initDB() {
    db = createClient({
        url: process.env.TURSO_DATABASE_URL,
        authToken: process.env.TURSO_AUTH_TOKEN
    });
    ...
}
```

**Lưu ý cú pháp thay đổi:**
| Cú pháp cũ (`sqlite`) | Cú pháp mới (`@libsql/client`) |
|---|---|
| `await db.get('SELECT ...')` | `(await db.execute('SELECT ...')).rows[0]` |
| `await db.all('SELECT ...')` | `(await db.execute('SELECT ...')).rows` |
| `await db.run('INSERT ...', [p1, p2])` | `await db.execute({ sql: 'INSERT ...', args: [p1, p2] })` |
| `await db.exec('CREATE TABLE...')` | `await db.executeMultiple('CREATE TABLE...')` |

> **Ảnh hưởng:** Cần cập nhật cú pháp tại **toàn bộ các lệnh query** trong `server.js`.  
> Lượng query ước tính: ~35 chỗ, tuy nhiên pattern thay thế rất đơn giản và nhất quán.

---

### Thay đổi 3 — `server.js`: Xóa background auto-sync khỏi `GET /api/products` (dòng 288–316)

Đoạn code chạy ngầm `performPosSync()` bên trong route `GET /api/products` phải được **xóa bỏ hoàn toàn**. Lý do: Vercel không cho phép process chạy sau khi response đã gửi.

**Trước:**
```js
res.json(products);
// Sau đây là code chạy ngầm — SẼ BỊ KILL TRÊN VERCEL
try {
    if (Date.now() - lastSync > 30 * 60 * 1000) {
        performPosSync(...).then(...).catch(...);
    }
} catch(syncErr) { ... }
```

**Sau:**
```js
res.json(products);
// Không có gì ở đây nữa — đồng bộ sẽ do Cron Job xử lý
```

---

### Thay đổi 4 — `server.js`: Tạo route Cron Job cho POS Sync (`/api/cron/pos-sync`)

Thêm một route mới, được Vercel Cron gọi mỗi 30 phút. Route này chạy `performPosSync()` bình thường, có đủ thời gian chạy (Vercel Cron timeout = 5 phút):

```js
// CRON JOB ROUTE — Chỉ được gọi bởi Vercel Cron, bảo vệ bằng secret header
app.get('/api/cron/pos-sync', async (req, res) => {
    const cronSecret = req.headers['x-cron-secret'];
    if (cronSecret !== process.env.CRON_SECRET) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    // ... gọi performPosSync() và trả kết quả
});
```

Thêm biến ENV: `CRON_SECRET=dhtk_cron_secret_2026` (ngẫu nhiên, để bảo vệ endpoint này).

---

### Thay đổi 5 — `[NEW] vercel.json` — Cấu hình Routing và Cron

```json
{
  "version": 2,
  "routes": [
    { "src": "/api/(.*)", "dest": "/server.js" },
    { "src": "/(.*)", "dest": "/public/$1" }
  ],
  "crons": [
    {
      "path": "/api/cron/pos-sync",
      "schedule": "*/30 * * * *"
    }
  ]
}
```

---

### Thay đổi 6 — `package.json`: Cập nhật scripts cho Vercel

```json
{
  "scripts": {
    "start": "node server.js",
    "build": "echo 'No build needed'"
  }
}
```

---

## Checklist Files cần thay đổi

| # | File | Loại | Ghi chú |
|---|---|---|---|
| 1 | `server.js` | MODIFY | Đổi DB driver, sửa ~35 query, xóa background sync, thêm cron route |
| 2 | `vercel.json` | **NEW** | Cấu hình routing và cron job |
| 3 | `package.json` | MODIFY | Thêm `@libsql/client`, xóa `sqlite3` và `sqlite` |
| 4 | `public/index.html` | ✅ KHÔNG SỬA | Không ảnh hưởng |
| 5 | `.env` | MODIFY | Thêm `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `CRON_SECRET` |

---

## Kế hoạch Xác minh

### Kiểm tra Local trước khi Deploy
1. Sau khi cài `@libsql/client` và sửa kết nối, chạy `node server.js` local.
2. Kiểm tra `GET /api/products` → vẫn trả về dữ liệu.
3. Đăng nhập Admin → mở Admin Panel → kiểm tra settings Telegram và POS.
4. Bấm đồng bộ POS thủ công → vẫn thành công.

### Kiểm tra sau khi Deploy lên Vercel
1. Truy cập domain Vercel → trang chủ load bình thường.
2. Admin đăng nhập → Admin Panel mở được.
3. Xem log Vercel → Cron Job được kích hoạt mỗi 30 phút.

---

## Open Questions

> ⚠️ **Cần xác nhận trước khi code:**

1. **Bạn đã có tài khoản Turso chưa?** Nếu có rồi, hãy cung cấp `TURSO_DATABASE_URL` và `TURSO_AUTH_TOKEN` để AI có thể viết code test kết nối ngay.
2. **Đồng bộ POS theo Cron 30 phút có đủ không?** Hoặc bạn muốn Admin vẫn có thể bấm đồng bộ thủ công ngay lập tức từ Admin Panel? (Route `/api/pos/sync` vẫn giữ nguyên, không bị ảnh hưởng.)
