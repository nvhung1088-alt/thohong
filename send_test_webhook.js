async function sendNewWebhook() {
    const webhookUrl = 'https://hook.eu2.make.com/9vsncffgvhshffpx9tnhfllmsnff2c0n'; // Or fetch from live server endpoint

    const imagesList = [
        'https://content.pancake.vn/2-24/2024/11/21/13db982e0b57732a326ff123f1bd084b664d4ed1.jpg',
        'https://thohong.top/media__1784598666512.png',
        'https://thohong.top/media_1786705348713.png',
        'https://thohong.top/media_1786802317076.jpg'
    ];

    const payload = {
        id: 'blog_' + Date.now(),
        title: '🌟 BST Sổ Tay & Tập Vở 4 Ô Ly Cao Cấp Mới Nhất 2026',
        slug: 'bst-so-tay-tap-vo-4-o-ly-cao-cap-moi-nhat-2026',
        excerpt: 'Tổng hợp mẫu sổ tay da, tập vở 4 ô ly mua sỉ giá tận gốc tại Tổng kho sỉ lẻ Thỏ Hồng Shop. Ưu đãi chiết khấu tự động cực khủng!',
        link: 'https://thohong.top/blog/bst-so-tay-tap-vo-4-o-ly-cao-cap-moi-nhat-2026',
        image: imagesList[0],
        image1: imagesList[0],
        image2: imagesList[1],
        image3: imagesList[2],
        image4: imagesList[3],
        images: imagesList,
        facebook_photos: imagesList.map(u => ({ url: u })),
        hashtags: '#SoTayDa #TapVo4OLy #ThoHongShop #PhuKienGiaSi #DongHangTietKiem',
        formatted_content: '📣 BÀI VIẾT MỚI TỪ THỎ HỒNG SHOP\n\n📌 🌟 BST Sổ Tay & Tập Vở 4 Ô Ly Cao Cấp Mới Nhất 2026\n\n📝 Tổng hợp mẫu sổ tay da, tập vở 4 ô ly mua sỉ giá tận gốc tại Tổng kho sỉ lẻ Thỏ Hồng Shop. Ưu đãi chiết khấu tự động cực khủng!\n\n👉 Đọc bài viết chi tiết tại đây:\nhttps://thohong.top/blog/bst-so-tay-tap-vo-4-o-ly-cao-cap-moi-nhat-2026\n\n#SoTayDa #TapVo4OLy #ThoHongShop #PhuKienGiaSi #DongHangTietKiem',
        created_at: new Date().toISOString()
    };

    console.log('Đang phát tín hiệu thử nghiệm bài viết mới có facebook_photos sang Make.com Webhook...');
    
    // Call live server to execute trigger
    try {
        const liveRes = await fetch('https://thohong.top/api/admin/social/make-share-now', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        console.log('Live server trigger status:', liveRes.status, await liveRes.text());
    } catch(e) {
        console.error('Live error:', e.message);
    }
}

sendNewWebhook().catch(err => console.error(err));
