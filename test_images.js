const { createClient } = require('@libsql/client');
const db = createClient({ url: 'file:./data/database.sqlite' });
async function run() {
    const slug = 'ban-si-so-tay-da-cao-cap-nguon-hang-gia-goc-tai-tong-kho-tho-hong-msvyjjbt';
    const res = await db.execute({ sql: 'SELECT cover_image, content FROM blog_posts WHERE slug = ?', args: [slug] });
    if(res.rows && res.rows.length > 0) {
        console.log('Cover Image:', res.rows[0].cover_image);
        const content = res.rows[0].content;
        const imgRegex = /<img[^>]+src=[\"']([^\"']+)[\"']/gi;
        let match;
        let count = 0;
        while ((match = imgRegex.exec(content)) !== null) {
            console.log('Found IMG src in content:', match[1]);
            count++;
        }
        console.log('Total HTML IMGs found by regex:', count);
        
        const mdRegex = /!\[.*?\]\((https?:\/\/[^\s\)]+)\)/g;
        let mdMatch;
        let mdCount = 0;
        while ((mdMatch = mdRegex.exec(content)) !== null) {
            console.log('Found MD IMG src in content:', mdMatch[1]);
            mdCount++;
        }
        console.log('Total MD IMGs found by regex:', mdCount);
    } else {
        console.log('Post not found');
    }
}
run();
