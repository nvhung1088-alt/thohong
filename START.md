# START.md — Nguồn Sự Thật Dự Án Thỏ Hồng Store (thohong)

## 📌 Trạng Thái Hiện Tại
- **Tên dự án**: Thỏ Hồng Store (`thohong`)
- **Repo GitHub**: `https://github.com/nvhung1088-alt/thohong.git`
- **Vercel Deploy**: `https://thohong.vercel.app` (Account: `dhtk2026`)
- **Kiến trúc**: Node.js Express + Turso Cloud (SQLite Engine v2 HTTP Pipeline) + Single Page HTML Frontend.
- **Trạng thái**: Đồng bộ hoàn toàn tính năng bảo mật, Turso Cloud HTTP, và kết nối Vercel Serverless.

## 🎯 Quyết Định Kiến Trúc & Công Nghệ
1. **Turso Engine**: Tự động chuyển đổi truy vấn SQLite sang Native HTTP Pipeline REST endpoint, giúp ứng dụng không bị timeout hoặc vỡ connection pool trên Serverless.
2. **Pancake POS V2**: Kết nối trực tiếp POS V2 qua API Key & Shop ID, đẩy thông tin đơn hàng đầy đủ địa chỉ shipping và thông tin khách hàng.
3. **Bảo mật**: Sử dụng JWT token bảo vệ các route cấu hình nhạy cảm và tiến trình sync.

## 📝 Nhật Ký Sprint
- **Sprint 1**: Chuẩn hóa giao diện Thỏ Hồng Store, tối ưu hóa CSS & trải nghiệm người dùng mobile.
- **Sprint 2**: Migrate CSDL SQLite sang Turso Cloud, tích hợp Vercel Serverless.
- **Sprint 3**: Đồng bộ tính năng đẩy đơn POS V2, kiểm thử luồng CI/CD Auto-Deploy từ GitHub sang Vercel.
