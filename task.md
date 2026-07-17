# Checklist Bảo mật API & Frontend ĐHTK

- [x] Sửa `server.js`
  - [x] Thêm in-memory Rate Limiter và Input Validation cho route `/api/orders`
  - [x] Sửa route `GET /api/settings` (chỉ trả về UI settings công khai)
  - [x] Thêm route `GET /api/settings/private` (yêu cầu `authenticateToken`)
  - [x] Sửa route `GET /api/pos/sync` (thêm middleware `authenticateToken`)
- [x] Sửa `public/index.html`
  - [x] Sửa hàm `openAdminPanel()` để fetch `/api/settings/private` trước khi render
  - [x] Sửa hiển thị Admin Stats badge khi storeSettings không có token nhạy cảm
- [x] Tạo tệp `.gitignore`
- [x] Kiểm tra xác minh và chạy thử nghiệm

# Checklist Di chuyển sang Vercel & Turso Cloud

- [x] Đăng ký CSDL Turso & Cấu hình biến môi trường `.env`
- [x] Cài đặt package `@libsql/client` (Client kết nối Turso)
- [x] Viết và thực thi script di chuyển dữ liệu từ SQLite cục bộ lên Turso Cloud (`migrate_to_turso.js`)
- [x] Thay thế kết nối CSDL và cú pháp query trong `server.js` tương thích hoàn toàn với Turso Client
- [x] Loại bỏ tiến trình đồng bộ POS ngầm có nguy cơ gây timeout trên Vercel khỏi API products
- [x] Tạo tệp định tuyến Serverless `vercel.json`
- [x] Kiểm thử kết nối và đọc/ghi CSDL Turso trên Local thành công
