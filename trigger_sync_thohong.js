async function triggerSync() {
    try {
        const baseUrl = process.env.BASE_URL || "https://thohong.top";
        console.log(`1. Đang đăng nhập Admin trên ${baseUrl}...`);
        const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ 
                username: process.env.ADMIN_USER || "admin", 
                password: process.env.ADMIN_PASSWORD || "dhtk2024" 
            })
        });
        const loginData = await loginRes.json();
        if (!loginData.token) {
            console.error("Đăng nhập thất bại!", loginData);
            return;
        }
        console.log("✅ Đăng nhập thành công! Đang gọi lệnh Đồng Bộ POS...");

        const syncRes = await fetch(`${baseUrl}/api/pos/sync`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${loginData.token}` }
        });
        const syncData = await syncRes.json();
        console.log("✅ Kết quả Đồng Bộ POS:", JSON.stringify(syncData, null, 2));
    } catch (e) {
        console.error("Lỗi:", e);
    }
}
triggerSync();
