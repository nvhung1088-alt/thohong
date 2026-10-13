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
4. **Auto-Blog Trigger (Lưu ý bài học)**: Vercel Free Plan giới hạn Cron Job (1 cron/ngày). TUYỆT ĐỐI KHÔNG thêm cron tần suất cao vào `vercel.json`. Bắt buộc dùng Dịch vụ CronJob bên ngoài (`cron-job.org`) ping định kỳ route `/api/cron/auto-blog` để đánh thức Serverless Function.

## 📝 Nhật Ký Sprint
- **Sprint 1**: Chuẩn hóa giao diện Thỏ Hồng Store, tối ưu hóa CSS & trải nghiệm người dùng mobile.
- **Sprint 2**: Migrate CSDL SQLite sang Turso Cloud, tích hợp Vercel Serverless.
- **Sprint 3**: Đồng bộ tính năng đẩy đơn POS V2, kiểm thử luồng CI/CD Auto-Deploy từ GitHub sang Vercel.
- **Sprint 4**: Khắc phục lỗi tự động nộp Google Indexing API & tự động cập nhật mốc thời gian indexed_at; Bổ sung cột Telegram SEO Status, nút ✈️ Share Telegram Hàng Loạt và sửa lỗi đóng khối ngoặc render bảng Telegram Tab.
- **Sprint 5**: Chuẩn hóa Webhook Make.com kết nối Facebook Pages: Tự động trích xuất đến 4 hình ảnh (`image1..4` và mảng `facebook_photos` dạng `[{ url }]`), sinh Hashtag CamelCase thông minh (`generateSmartHashtags`) và format nội dung bài viết bắt mắt (`formatted_content`). Pushed & Deployed Vercel thành công cho cả `thohong` và `DHTK`.
- **Sprint 6**: Khắc phục lỗi Facebook Pages `CreatePostWithPhotos` trên Make.com: Đã bổ sung thuộc tính `type: 'url'` cho mảng `facebook_photos` khớp schema Make.com, đồng thời nâng cấp toàn bộ luồng Blog AI Generator (`/api/admin/blog/generate`): Tự động lọc chính xác 5 sản phẩm khớp từ khóa SEO bài viết trong CSDL kho hàng, tự động bổ sung nguồn ảnh HD Internet (Unsplash) chuẩn ngành hàng khi CSDL thiếu ảnh, giữ nguyên luồng Tự động Xuất bản (Auto-Publish) đa kênh.
- **Sprint 7 (Hoàn thành)**: Cập nhật UI Make.com Automation. Bổ sung trạng thái Loading (⏳ Đang gửi...) cho nút Share đơn lẻ để chống click đúp. 
- **Sprint 8 (Hoàn thành)**: Giải quyết dứt điểm lỗi Make.com Webhook & Facebook Pages. Khắc phục lỗi ngập lụt Queue bằng delay, chuẩn hóa parse mảng ảnh.
- **Sprint 9 (Hoàn thành)**: Đồng bộ mã nguồn 100% giữa dự án DHTK và Thỏ Hồng. Hợp nhất AI Keyword SEO (nhận diện ngành hàng thông minh), dọn dẹp triệt để cross-domain hardcoded (thohong.top vs dhtk.vercel.app), và bổ sung trang 404 cho Thỏ Hồng. Hai dự án dùng chung 1 khung code chuẩn.
- **Sprint 10 (Hoàn thành)**: Vá triệt để các lỗ hổng bảo mật mảng đồng bộ POS: Bảo vệ route `/api/pos/sync` bằng `authenticateToken` (chống DDoS & Rate Limit POS), xác nhận bọc kín API `/api/settings` chỉ trả public keys, dọn dẹp và chuẩn hóa các kịch bản test/trigger sync sang `trigger_sync_thohong.js` và `test_thohong_push.js`.
- **Sprint 11 (Hoàn thành)**: Nâng cấp toàn diện tính năng Import Excel: Sửa lỗi hiển thị thừa số lượng sản phẩm (chỉ đếm đúng số SP vừa đọc từ file Excel), nâng cấp hỗ trợ đầy đủ 6 trường giá sỉ (`Yêu Cầu Sỉ 1, 2, 3` và `Giá Sỉ 1, 2, 3`), tự động bóc tách số điều kiện sỉ, đồng thời tích hợp cơ chế Chống Trùng Mã Sản Phẩm (DEDUP BY SKU): Tự động Cập nhật (Update) sản phẩm cũ đã có trên hệ thống thay vì tạo trùng lặp.
- **Sprint 12 (Hoàn thành)**: Đồng bộ cấu hình `vercel.json` chuẩn Vercel Hobby, bổ sung `await` cho `triggerMakeWebhook` trong chu kỳ tự động viết bài Blog AI để bài viết được phát ngay sang Make.com trước khi Vercel đóng băng Serverless instance.
- **Sprint 13 (Hoàn thành)**: Đồng bộ sửa lỗi SSR Bot chống timeout Googlebot ("Đã phát hiện thấy – hiện chưa được lập chỉ mục"): Sửa lỗi `ReferenceError: settings is not defined`, chuẩn hóa truy vấn CSDL sang bảng `blog_posts` (`cover_image`, `created_at`, `updated_at`), đồng bộ trang `/blog` và toàn bộ bài viết vào dynamic `/sitemap.xml`, bọc top-level try-catch và `AbortSignal.timeout(5000)` bảo vệ bot requests luôn phản hồi siêu tốc.
- **Sprint 14 (Hoàn thành)**: Mở khóa và bảo vệ tính năng tự động cập nhật tồn kho Pancake POS (`/api/pos/sync`) tương thích 100% với `cron-job.org` (chu kỳ 3-5h/lần): Thiết lập middleware `authenticatePosSyncOrCron` hỗ trợ đa chế độ xác thực (Admin JWT, `cron_secret` query/header, và public automated ping với cơ chế bảo vệ Cooldown 2 phút chống spam/DDoS). Đã deploy và kiểm thử live thành công (HTTP 200 OK).
