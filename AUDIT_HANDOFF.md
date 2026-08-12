# AUDIT HANDOFF: TÍNH NĂNG ĐẨY ĐƠN HÀNG LÊN PANCAKE POS CHO WEB DHTK

## 1. Mục Tiêu Task
Bê nguyên luồng đồng bộ đơn hàng với Pancake POS (đã được fix và tối ưu trên web `thohong`) sang dự án `DHTK` (Đồng Hành Tiết Kiệm). Bao gồm việc gửi đúng định dạng JSON cho Pancake V2 và hiển thị mã đơn hàng thành công trên Frontend.

## 2. Trạng Thái Hiện Tại (As-Is)
Sau khi quét repository `DHTK`:
- **Backend (`server.js`)**:
  - Hàm `pushOrderToPancake` đang chạy ngầm (async) mà không `await`, dẫn đến việc không thể trả kết quả/lỗi từ POS về cho Frontend.
  - Payload gửi đi vẫn đang dùng cấu trúc Pancake V1 cũ (`customer: {name, phone, address}`) và `source: ...`, khiến Pancake V2 từ chối/bỏ qua thông tin khách hàng.
- **Frontend (`public/index.html`)**:
  - Hàm `submitOrder()` (dòng ~600) hiển thị thông báo thành công tĩnh (`alert('✅ Đơn hàng đã được gửi thành công...')`) mà không cần biết POS có nhận được hay không, và không có mã ID đơn hàng.
- **Cơ sở dữ liệu**:
  - Cần đảm bảo `pos_variant_id` trong DB Turso của `DHTK` đã được chuyển sang định dạng GUID/TEXT thay vì số nguyên (Integer) như lỗi từng gặp ở `thohong`.

## 3. Các Vị Trí Code (Call Sites) Cần Can Thiệp
1. **`server.js` (Endpoint `/api/orders`)**:
   - Khoảng dòng 729: Cần thay đổi `pushOrderToPancake` thành `await`, gán `posSuccess` và `posOrderId`.
   - Trả về `posSuccess` và `posOrderId` trong `res.json`.
2. **`server.js` (Hàm `pushOrderToPancake`)**:
   - Khoảng dòng 760-775: Thay đổi Payload JSON:
     - Xóa object `customer`.
     - Thêm `bill_full_name`, `bill_phone_number`.
     - Thêm `shipping_address: { full_name, phone_number, full_address, address }`.
     - Đổi `source` thành `order_sources`.
   - Cập nhật hàm trả về `return result` để `await` có thể nhận kết quả.
3. **`public/index.html` (Hàm `submitOrder()`)**:
   - Khoảng dòng 600: Cập nhật hàm `alert` để hiển thị logic "Mã đơn hàng", "Thành công trên POS/Telegram" nếu `json.posSuccess == true`.

## 4. Rủi Ro & Chú Ý
- Vercel của dự án DHTK cần được liên kết đúng với Repository `nvhung1088-alt/DHTK` và tự động Build khi push.
- Bắt buộc phải clear cache trình duyệt hoặc dùng tab ẩn danh khi test Frontend DHTK.
- Database của DHTK có thể chưa sync đủ Product/Variant GUID từ Pancake V2, nên có thể cần chạy `run_sync_direct.js` cho DHTK trước khi test.

---
**Model đề xuất cho bước tiếp theo (PLAN)**: `Opus` hoặc `Pro` (Đọc Handoff này và viết Plan 3 giai đoạn).
