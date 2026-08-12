require('dotenv').config();

const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN;

let url = tursoUrl;
if (url && url.startsWith('libsql://')) url = url.replace('libsql://', 'https://');
if (url && url.startsWith('pos-')) url = 'https://' + url;

const db = {
    execute: async (sql, args = []) => {
        let stmt = sql;
        let stmtArgs = args;
        if (typeof sql === 'object' && sql.sql) {
            stmt = sql.sql;
            stmtArgs = sql.args || [];
        }
        const response = await fetch(`${url}/v2/pipeline`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tursoToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                requests: [
                    { type: "execute", stmt: { sql: stmt, args: stmtArgs.map(a => typeof a === 'number' ? { type: 'integer', value: String(a) } : { type: 'text', value: String(a) }) } },
                    { type: "close" }
                ]
            })
        });
        const data = await response.json();
        if (!data.results || !data.results[0] || !data.results[0].response) {
            return { rows: [] };
        }
        const result = data.results[0].response.result;
        const cols = result.cols.map(c => c.name);
        return {
            rows: result.rows.map(r => {
                const row = {};
                cols.forEach((col, i) => row[col] = r[i].value);
                return row;
            })
        };
    },
    executeBatch: async (batchStmts) => {
        const requests = batchStmts.map(s => ({
            type: "execute",
            stmt: {
                sql: s.sql,
                args: (s.args || []).map(a => typeof a === 'number' ? { type: 'integer', value: String(a) } : { type: 'text', value: String(a) })
            }
        }));
        requests.push({ type: "close" });

        const response = await fetch(`${url}/v2/pipeline`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${tursoToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ requests })
        });
        return await response.json();
    }
};

async function syncNow() {
    const posCredentials = {
        apiKey: process.env.PANCAKE_API_KEY,
        shopId: process.env.PANCAKE_SHOP_ID,
        warehouseId: process.env.PANCAKE_WAREHOUSE_ID
    };

    console.log("Starting sync with credentials:", posCredentials.shopId);

    // Fetch all products from Pancake
    let allPosProducts = [];
    let page = 1;
    let totalPages = 1;

    const getParams = (pg) => {
        const params = new URLSearchParams({
            api_key: posCredentials.apiKey,
            page_number: pg,
            page_size: 50
        });
        if (posCredentials.warehouseId) {
            params.append('warehouse_id', posCredentials.warehouseId);
        }
        return params.toString();
    };

    const firstUrl = `https://pos.pages.fm/api/v1/shops/${posCredentials.shopId}/products?${getParams(1)}`;
    const firstResp = await fetch(firstUrl);
    const firstResult = await firstResp.json();
    totalPages = firstResult.total_pages || 1;
    allPosProducts = allPosProducts.concat(firstResult.products || firstResult.data || []);

    if (totalPages > 1) {
        const promises = [];
        for (let pg = 2; pg <= totalPages; pg++) {
            const u = `https://pos.pages.fm/api/v1/shops/${posCredentials.shopId}/products?${getParams(pg)}`;
            promises.push(fetch(u).then(r => r.json()).then(res => res.products || res.data || []).catch(() => []));
        }
        const results = await Promise.all(promises);
        results.forEach(p => allPosProducts = allPosProducts.concat(p));
    }

    console.log(`Fetched ${allPosProducts.length} POS products.`);

    const skuStockMap = {};
    const getStock = (obj) => {
        if (obj.inventories && Array.isArray(obj.inventories) && obj.inventories.length > 0) {
            if (posCredentials.warehouseId) {
                const whInv = obj.inventories.find(inv => 
                    String(inv.warehouse_id) === String(posCredentials.warehouseId) || String(inv.id) === String(posCredentials.warehouseId)
                );
                if (whInv) return whInv.available_quantity ?? whInv.available ?? whInv.quantity ?? 0;
            }
            return obj.inventories.reduce((sum, inv) => sum + (inv.available_quantity ?? inv.available ?? inv.quantity ?? 0), 0);
        }
        return obj.available_quantity ?? obj.available ?? obj.stock ?? 0;
    };

    allPosProducts.forEach(posProduct => {
        const variations = posProduct.variations || posProduct.product_variations || [];
        const pId = posProduct.id || posProduct.product_id;
        if (variations.length === 0) {
            const code = posProduct.code || posProduct.sku || posProduct.id;
            if (code) {
                skuStockMap[String(code).trim().toUpperCase()] = {
                    stock: getStock(posProduct),
                    pos_product_id: pId,
                    pos_variant_id: null
                };
            }
        } else {
            variations.forEach(v => {
                const sku = v.code || v.sku || v.barcode;
                if (sku) {
                    skuStockMap[String(sku).trim().toUpperCase()] = {
                        stock: getStock(v),
                        pos_product_id: pId || v.product_id,
                        pos_variant_id: v.id || v.variation_id
                    };
                }
            });
        }
    });

    const resultProducts = await db.execute('SELECT * FROM products');
    const dbProducts = resultProducts.rows;
    const batchStmts = [];

    for (const localProduct of dbProducts) {
        let details = {};
        try { if (localProduct.details) details = JSON.parse(localProduct.details); } catch(e) {}
        let variants = details.variants || [];
        let isUpdated = false;
        let productQuantitySum = 0;

        if (variants.length === 0) {
            const parentSku = (localProduct.sku || '').trim().toUpperCase();
            if (parentSku && skuStockMap.hasOwnProperty(parentSku)) {
                const posData = skuStockMap[parentSku];
                productQuantitySum = posData.stock;
                details.pos_product_id = posData.pos_product_id;
                details.pos_variant_id = posData.pos_variant_id;
                isUpdated = true;
            } else {
                productQuantitySum = localProduct.quantity || 0;
            }
        } else {
            variants.forEach(v => {
                const skuKey = (v.sku || '').trim().toUpperCase();
                if (skuKey && skuStockMap.hasOwnProperty(skuKey)) {
                    const posData = skuStockMap[skuKey];
                    v.stock = posData.stock;
                    v.pos_product_id = posData.pos_product_id;
                    v.pos_variant_id = posData.pos_variant_id;
                    isUpdated = true;
                    productQuantitySum += posData.stock;
                } else {
                    productQuantitySum += (v.stock || 0);
                }
            });
        }

        if (isUpdated) {
            details.variants = variants;
            batchStmts.push({
                sql: 'UPDATE products SET quantity = ?, details = ? WHERE id = ?',
                args: [productQuantitySum, JSON.stringify(details), localProduct.id]
            });
        }
    }

    if (batchStmts.length > 0) {
        const BATCH_CHUNK = 200;
        for (let i = 0; i < batchStmts.length; i += BATCH_CHUNK) {
            await db.executeBatch(batchStmts.slice(i, i + BATCH_CHUNK));
        }
        console.log(`Successfully updated ${batchStmts.length} products with POS IDs in Turso DB!`);
    } else {
        console.log("No updates needed.");
    }
}

syncNow().catch(console.error);
