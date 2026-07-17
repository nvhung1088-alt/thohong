# Báo cáo Audit Bảo mật & Rủi ro Kiến trúc (DHTK Store)

Báo cáo này đánh giá mức độ an toàn của hệ thống, phân tích điểm mạnh, điểm yếu và các rủi ro chí mạng khi triển khai mã nguồn lên nền tảng đám mây **Vercel**.

---

## 🚨 Rủi ro Kiến trúc Chí mạng (Vercel Deployment)

Vercel là một nền tảng **Serverless (Function-as-a-Service)**. Việc đưa ứng dụng Node.js hiện tại lên Vercel có một rủi ro kiến trúc cực lớn:

* **SQLite File cục bộ (`dhtk_store.db`) sẽ mất sạch dữ liệu:** 
  Môi trường chạy Serverless của Vercel là Read-Only và lưu trữ tạm thời (Ephemeral storage). Mỗi lần Serverless Function khởi động lại (cold start), scale-up hoặc khi deploy phiên bản mới, file SQLite sẽ tự động bị reset về trạng thái ban đầu đi kèm bản build. Mọi sản phẩm import, cấu hình POS Pancake và Telegram do Admin lưu sẽ **bị xóa sạch liên tục**.
* **Giải pháp khắc phục:** 
  1. *Cách khuyên dùng 1:* Triển khai Backend lên các nền tảng VPS thông thường hoặc Cloud Container như **Render.com**, **Railway.app**, **Fly.io** (các dịch vụ này hỗ trợ Persistent Disk để lưu trữ file SQLite vĩnh viễn và chạy NodeJS liên tục 24/7).
  2. *Cách khuyên dùng 2 (Nếu bắt buộc lên Vercel):* Chuyển đổi database từ SQLite file cục bộ sang một Database Cloud (ví dụ: dùng dịch vụ SQLite Cloud miễn phí của **Turso**, hoặc PostgreSQL của **Supabase** / **Neon**).

---

## 🔒 Phân tích Lỗ hổng Bảo mật API (Security Vulnerabilities)

Qua việc rà soát mã nguồn `server.js` hiện tại, tôi phát hiện ra một số lỗ hổng bảo mật nghiêm trọng có thể làm rò rỉ dữ liệu nhạy cảm:

### 1. Lộ lọt API Key POS và Token Telegram (Rất Nghiêm Trọng)
* **Hiện tại:** Route `GET /api/settings` trả về toàn bộ dữ liệu trong bảng `settings` và **không yêu cầu xác thực Admin** (`authenticateToken`).
* **Hậu quả:** Bất kỳ ai truy cập website, chỉ cần mở F12 (Network tab) là có thể xem được **Token Bot Telegram**, **Chat ID nhóm nhận đơn**, **API Key Pancake POS** và **Shop ID** của bạn. Họ có thể dùng Token này để spam nhóm Telegram hoặc hack dữ liệu đơn hàng trên POS Pancake.
* **Giải pháp:** Tách API cài đặt thành 2 phần:
  * `GET /api/settings`: Chỉ trả về thông tin giao diện công khai (bannerTitle, logoText, metaDescription...).
  * `GET /api/settings/private` (Admin Only): Yêu cầu token JWT của Admin để lấy các khóa nhạy cảm.

### 2. Kích hoạt đồng bộ POS trái phép (Nghiêm Trọng)
* **Hiện tại:** Route `GET /api/pos/sync` dùng để đồng bộ tồn kho POS **không yêu cầu xác thực**.
* **Hậu quả:** Bất kỳ ai cũng có thể spam gọi API này liên tục khiến server bị nghẽn (do fetch Pancake mất nhiều thời gian) và tài khoản POS của bạn bị khóa (Rate Limit) do Pancake nghi ngờ bị tấn công.
* **Giải pháp:** Thêm middleware `authenticateToken` bảo vệ. Chỉ cho phép Admin kích hoạt đồng bộ thủ công.

### 3. Nguy cơ Spam Đơn Hàng ảo sang Telegram (Trung bình)
* **Hiện tại:** Route `POST /api/orders` dùng để khách đặt hàng (không cần auth) và server tự động gửi thông báo Telegram.
* **Hậu quả:** Kẻ xấu có thể viết script spam gửi hàng nghìn đơn ảo liên tục, làm ngập lụt kênh Telegram của bạn và làm nghẽn API.
* **Giải pháp:** Tích hợp bộ giới hạn tần suất gửi đơn (Rate Limiter) đơn giản hoặc captcha ngầm.

---

## 📊 Đánh giá Tổng quan (SWOT)

### 💪 Điểm mạnh (Strengths)
* **Xác thực Admin:** Mật khẩu đã được băm SHA-256 an toàn trong DB và xác thực qua JWT token thời hạn hợp lý.
* **Xử lý dữ liệu:** API POS đã được cải tiến chạy ngầm, không gây trễ giao diện cho khách hàng.

### ⚠️ Điểm yếu (Weaknesses)
* Cấu trúc Database SQLite phụ thuộc vào ổ đĩa ghi cục bộ, khó nâng cấp scale-out trên môi trường Serverless.
* Phân tách quyền hạn API (Access Control) chưa triệt để, để lộ thông tin cấu hình nhạy cảm.

### 🚀 Cơ hội (Opportunities)
* Hệ thống nhỏ gọn, dễ dàng chuyển đổi sang Turso (Cloud SQLite) chỉ với 10 dòng code thay đổi kết nối để chạy 100% ổn định trên Vercel miễn phí.

---

## 📝 Đề xuất các bước hoàn thiện bảo mật tiếp theo
1. **Sửa đổi API Settings:** Tách biệt dữ liệu công khai và dữ liệu mật của Admin.
2. **Bảo vệ API Sync:** Khóa chặt route đồng bộ POS bằng quyền Admin.
3. **Cấu hình ENV khi Deploy:** Tuyệt đối không upload file `.env` lên GitHub. Khi deploy lên Vercel/Render, phải nhập các biến này vào mục Environment Variables của Dashboard điều khiển.
