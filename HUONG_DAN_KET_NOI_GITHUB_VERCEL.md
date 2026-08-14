# 🚀 HƯỚNG DẪN KẾT NỐI & ĐỒNG BỘ 2 DỰ ÁN (DHTK & THỎ HỒNG) LÊN GITHUB VA VERCEL

Tài liệu này chi tiết hóa cấu hình kết nối giữa **Máy cục bộ (Local)** ➔ **GitHub (`nvhung1088-alt`)** ➔ **Vercel (`dhtk2026`)**.

---

## 📌 1. THÔNG TIN KẾT NỐI TỔNG QUAN

| Thành Phần | Dự Án 1: Đồng Hành Tiết Kiệm (DHTK) | Dự Án 2: Thỏ Hồng Store (thohong) |
|---|---|---|
| **Thư mục Local** | `c:\Users\ADMIN\OneDrive\Desktop\web\DHTK` | `c:\Users\ADMIN\OneDrive\Desktop\web\thohong` |
| **GitHub Repository** | `https://github.com/nvhung1088-alt/DHTK.git` | `https://github.com/nvhung1088-alt/thohong.git` |
| **Vercel Project** | `dhtk` (trong Team/Account `dhtk2026`) | `thohong` (trong Team/Account `dhtk2026`) |
| **Domain Chính** | `donghangtietkiem.com` / `dhtk.vercel.app` | `thohong.top` / `thohong.vercel.app` |
| **Nhánh mặc định** | `main` | `main` |

---

## 🛠️ 2. QUY TRÌNH KẾT NỐI TỪ LOCAL LÊN GITHUB

Cả 2 thư mục đã được khởi tạo và liên kết chính xác với GitHub Remote. 

### Bước 1: Kiểm tra kết nối Remote tại Local
Mở terminal PowerShell tại thư mục làm việc và kiểm tra:

```powershell
# Kiểm tra project DHTK
git -C "c:\Users\ADMIN\OneDrive\Desktop\web\DHTK" remote -v

# Kiểm tra project thohong
git -C "c:\Users\ADMIN\OneDrive\Desktop\web\thohong" remote -v
```

Nếu chưa đúng remote URL, chạy lệnh sau để gán lại:
```powershell
# Cho DHTK
git -C "c:\Users\ADMIN\OneDrive\Desktop\web\DHTK" remote set-url origin https://github.com/nvhung1088-alt/DHTK.git

# Cho thohong
git -C "c:\Users\ADMIN\OneDrive\Desktop\web\thohong" remote set-url origin https://github.com/nvhung1088-alt/thohong.git
```

### Bước 2: Quy trình Push Code tự động Deploy

Mỗi khi bạn sửa code tại máy cục bộ, chạy các lệnh sau để đẩy code lên GitHub. Vercel sẽ **tự động nhận diện commit mới và Build/Deploy trong 10-15 giây**:

#### 🔹 Đẩy code dự án DHTK:
```powershell
cd c:\Users\ADMIN\OneDrive\Desktop\web\DHTK
git add .
git commit -m "feat: cập nhật tính năng mới cho DHTK"
git push origin main
```

#### 🔹 Đẩy code dự án Thỏ Hồng:
```powershell
cd c:\Users\ADMIN\OneDrive\Desktop\web\thohong
git add .
git commit -m "feat: cập nhật tính năng mới cho thohong"
git push origin main
```

---

## ⚙️ 3. CẤU HÌNH BIẾN MÔI TRƯỜNG (ENVIRONMENT VARIABLES) TRÊN VERCEL

Để dự án chạy ổn định và kết nối CSDL Turso Cloud + JWT + POS, bạn cần cài đặt đủ các Biến môi trường trên **Vercel Dashboard** -> **Project Settings** -> **Environment Variables**:

### Danh sách Biến Môi Trường Cần Điền Trên Vercel:

| Tên Biến (Key) | Giá trị (Value) | Mô tả |
|---|---|---|
| `TURSO_DATABASE_URL` | `https://<your-db-name>-<user>.turso.io` | URL kết nối Turso Database Cloud |
| `TURSO_AUTH_TOKEN` | `ey...` | Token xác thực Turso Cloud |
| `JWT_SECRET` | `<chuỗi-mật-mã-ngẫu-nhiên>` | Khóa mã hóa Token Admin JWT |
| `PANCAKE_API_KEY` | `<token-pancake>` | Token API kết nối Pancake POS V2 |
| `PANCAKE_SHOP_ID` | `<shop-id-pancake>` | ID cửa hàng trên Pancake |
| `TELEGRAM_BOT_TOKEN` | `<bot-token>` | Token Telegram Bot gửi thông báo đơn |
| `TELEGRAM_CHAT_ID` | `<chat-id>` | ID nhóm Telegram nhận thông báo đơn |

> ⚠️ **LƯU Ý QUAN TRỌNG**: Sau khi thay đổi Environment Variables trên Vercel, bạn phải vào tab **Deployments** -> chọn Deployment gần nhất -> bấm nút **Redeploy** thì cấu hình mới có hiệu lực!

---

## 🔄 4. LUỒNG ĐỒNG BỘ ĐƠN HÀNG & DỮ LIỆU GIỮA 2 SHOP

1. **Database**: Cả 2 dự án đều sử dụng Turso Cloud HTTP Engine thông qua endpoint `/v2/pipeline` để gọi SQL không qua kết nối TCP vĩnh viễn (phù hợp 100% với Vercel Serverless).
2. **Deploy Status**: Trong Vercel Dashboard (`vercel.com/dhtk2026/dhtk/deployments`), trạng thái `Ready` màu xanh thể hiện code đã được deploy thành công. Nếu báo `Error` màu đỏ, bấm vào dòng log để xem chi tiết lỗi syntax/missing modules.
