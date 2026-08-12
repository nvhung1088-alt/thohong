const SHOP_ID = process.env.PANCAKE_SHOP_ID || "860217017";
const API_KEY = process.env.PANCAKE_API_KEY || "49a4811c88044bba9601b60159c68735";
const WAREHOUSE_ID = process.env.PANCAKE_WAREHOUSE_ID || "dac2f936-28a2-4ac0-b6ba-c3dba5ddf4b1";

async function test() {
    // Payload của một sản phẩm (ví dụ Gọt Xoáy Chì mà tôi đã sync được id đúng)
    const orderPayload = {
        order: {
            order_sources: 'ĐHTK Store',
            warehouse_id: WAREHOUSE_ID,
            bill_full_name: "Test Khách DHTK",
            bill_phone_number: "0987123123",
            shipping_address: {
                full_name: "Test Khách DHTK",
                phone_number: "0987123123",
                full_address: "123 Đường Test DHTK",
                address: "123 Đường Test DHTK"
            },
            note: 'Đơn test từ web DHTK',
            items: [
                {
                    quantity: 1,
                    price: 14400,
                    product_id: "6f8136b7-ecd3-4499-810b-0eb20c7b1419",
                    variation_id: "f977e559-7cbd-4839-88ab-3076ff65ea95"
                }
            ]
        }
    };

    const url = `https://pos.pages.fm/api/v1/shops/${SHOP_ID}/orders?api_key=${API_KEY}`;
    console.log(`[PANCAKE ORDER SYNC] Đang đẩy đơn hàng sang Pancake POS Shop ${SHOP_ID}...`);

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderPayload)
        });

        const result = await resp.json();
        console.log('[PANCAKE ORDER SYNC RESULT]:', JSON.stringify(result, null, 2));
    } catch (err) {
        console.error('[PANCAKE ORDER SYNC ERROR]:', err.message);
    }
}

test();
