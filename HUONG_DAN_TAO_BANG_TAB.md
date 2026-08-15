# 📖 HƯỚNG DẪN CHI TIẾT: THIẾT KẾ & NHÂN BẢN BẢNG DỮ LIỆU ĐA TAB (MULTI-TAB DATA TABLE PATTERN)

> **Mục tiêu**: Giúp tạo mới hoặc sao chép bất kỳ Bảng Quản Lý Dữ Liệu (Data Table) nào sang các Tab khác trong Admin CP **siêu nhanh (< 2 phút)**, đảm bảo chuẩn giao diện UI/UX và **100% không bao giờ bị lỗi kẹt "Đang tải danh sách..."**.

---

## 🏗️ 1. NGUYÊN TẮC THIẾT KẾ CỐT LÕI (CORE RULES)

1. **Quy tắc Độc Lập Element (Isolated Elements)**:
   - Mỗi Tab phải có một thẻ `<tbody>` với **ID duy nhất** (Ví dụ: `indexingPostsTableBody`, `telegramTabPostsTableBody`, `facebookTabPostsTableBody`).
2. **Quy tắc Khối Render JS Độc Lập (Independent Render Blocks)**:
   - Trong hàm JavaScript nạp dữ liệu, mỗi phần tử `tbody` phải nằm trong một khối `if (element) { ... }` riêng biệt.
   - ⚠️ **LỖI CẦN TRÁNH**: Tuyệt đối KHÔNG lồng khối `if (tbody2)` bên trong khối `if (tbody1)` vì sẽ làm bảng ở Tab 2 bị kẹt khi Tab 1 chưa xuất hiện trên DOM.
3. **Quy tắc Tự Động Trigger Khi Chuyển Tab**:
   - Trong hàm chuyển tab (`switchApanelTab(tabId)`), luôn gọi hàm nạp dữ liệu tương ứng khi tab đó được mở.

---

## 🎨 2. TEMPLATE HTML CHUẨN (COPY & PASTE NGAY)

Sao chép đoạn HTML dưới đây dán vào bất kỳ Tab nào cần hiển thị Bảng:

```html
<!-- Bảng Quản Lý Dữ Liệu Đa Tab [Đổi Tên Tab Ở Đây] -->
<div style="background:white; border:1px solid #bae6fd; border-radius:10px; padding:15px; margin-top:15px;">
    <!-- Thanh Header Của Bảng -->
    <div style="font-size:0.88rem; font-weight:700; color:#0369a1; margin-bottom:10px; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:8px;">
        <span>📢 [TIÊU ĐỀ BẢNG - VD: TRẠNG THÁI CHIA SẺ TELEGRAM]</span>
        <button class="btn" style="background:#0088cc; color:white; font-size:0.78rem; font-weight:bold; padding:6px 12px; border-radius:6px;" onclick="[TÊN_HÀM_HÀNG_LOẠT()]">✈️ [NÚT THAO TÁC HÀNG LOẠT]</button>
    </div>

    <!-- Khung Chứa Bảng Có Scrollbar -->
    <div style="max-height:350px; overflow-y:auto; border:1px solid #e2e8f0; border-radius:8px;">
        <table style="width:100%; border-collapse:collapse; font-size:0.82rem; text-align:left;">
            <thead>
                <tr style="background:#f0f9ff; border-bottom:1px solid #bae6fd; color:#0369a1; position:sticky; top:0; z-index:1;">
                    <th style="padding:8px 12px;">Cột 1 (Ví dụ: Tiêu đề)</th>
                    <th style="padding:8px 12px;">Cột 2 (Trạng thái)</th>
                    <th style="padding:8px 12px;">Cột 3 (Thời gian/Log)</th>
                    <th style="padding:8px 12px; text-align:right;">Hành động</th>
                </tr>
            </thead>
            <!-- Đổi ID tbody cho từng Tab -->
            <tbody id="[TÊN_TAB_TBODY_ID]">
                <tr><td colspan="4" style="padding:15px; text-align:center; color:#94a3b8;">Đang tải danh sách bài viết...</td></tr>
            </tbody>
        </table>
    </div>
</div>
```

---

## ⚡ 3. TEMPLATE JAVASCRIPT RENDER ĐA TAB CHUẨN

Đoạn mã JavaScript mẫu hỗ trợ render tự động đồng thời lên **nhiều Tab cùng lúc** mà không bao giờ bị lỗi crash:

```javascript
// Biến lưu cache dữ liệu toàn cục
let cachedMultiTabPosts = [];

async function loadMultiTabData() {
    const token = localStorage.getItem('dhtk_jwt');
    if (!token) return;

    try {
        const res = await fetch('/api/admin/seo/indexing-posts', {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        const data = await res.json();
        const posts = data.posts || [];
        cachedMultiTabPosts = posts;

        // ==========================================
        // 🔹 KHỐI 1: RENDER CHO TAB GOOGLE INDEX
        // ==========================================
        const tbodyIndex = document.getElementById('indexingPostsTableBody');
        if (tbodyIndex) {
            if (posts.length === 0) {
                tbodyIndex.innerHTML = '<tr><td colspan="5" style="padding:15px; text-align:center; color:#94a3b8;">Chưa có dữ liệu</td></tr>';
            } else {
                tbodyIndex.innerHTML = posts.map(p => `
                    <tr style="border-bottom:1px solid #f1f5f9;">
                        <td style="padding:10px 12px; font-weight:700;">${escapeHtml(p.title)}</td>
                        <td style="padding:10px 12px;">${p.status}</td>
                        <td style="padding:10px 12px;">${p.indexed_at ? '🟢 Đã nộp' : '⏳ Chưa nộp'}</td>
                        <td style="padding:10px 12px;">${p.telegram_shared_at ? '🟢 Đã share' : '⏳ Chưa share'}</td>
                        <td style="padding:10px 12px; text-align:right;">
                            <button class="btn" onclick="handleAction('${p.id}')">Thao tác</button>
                        </td>
                    </tr>
                `).join('');
            }
        } // 🟢 ĐÓNG NGOẶC KHỐI 1 ĐỘC LẬP Ở ĐÂY!

        // ==========================================
        // 🔹 KHỐI 2: RENDER CHO TAB TELEGRAM (HOẶC TAB MỚI)
        // ==========================================
        const tbodyTelegram = document.getElementById('telegramTabPostsTableBody');
        if (tbodyTelegram) {
            if (posts.length === 0) {
                tbodyTelegram.innerHTML = '<tr><td colspan="4" style="padding:15px; text-align:center; color:#94a3b8;">Chưa có dữ liệu</td></tr>';
            } else {
                tbodyTelegram.innerHTML = posts.map(p => `
                    <tr style="border-bottom:1px solid #f1f5f9;">
                        <td style="padding:10px 12px; font-weight:700;">${escapeHtml(p.title)}</td>
                        <td style="padding:10px 12px;">${p.status}</td>
                        <td style="padding:10px 12px;">${p.telegram_shared_at ? '🟢 Đã chia sẻ' : '⏳ Chưa chia sẻ'}</td>
                        <td style="padding:10px 12px; text-align:right;">
                            <button class="btn" style="background:#0088cc; color:white;" onclick="triggerShareBlogTelegram('${p.id}')">✈️ Share Telegram</button>
                        </td>
                    </tr>
                `).join('');
            }
        } // 🟢 ĐÓNG NGOẶC KHỐI 2 ĐỘC LẬP Ở ĐÂY!

    } catch (e) {
        console.error('[loadMultiTabData Error]', e);
    }
}
```

---

## 🛠️ 4. QUY TRÌNH 3 BƯỚC THÊM BẢNG VÀO TAB MỚI

1. **Bước 1**: Copy đoạn HTML Template ở Mục 2, dán vào Tab mới (ví dụ `#tab-facebook`). Đổi `tbody id="facebookTabPostsTableBody"`.
2. **Bước 2**: Trong hàm JS `loadMultiTabData()`, copy một khối `if (tbodyX)` mới dán xuống dưới, đổi ID thành `document.getElementById('facebookTabPostsTableBody')`.
3. **Bước 3**: Trong hàm chuyển Tab (`switchApanelTab(tabId)`), bổ sung thêm dòng:
   ```javascript
   if (tabId === 'tab-facebook') {
       loadMultiTabData();
   }
   ```
