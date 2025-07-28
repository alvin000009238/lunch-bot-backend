// --- 1. 引入需要的套件 ---
const express = require('express');
const line = require('@line/bot-sdk');
const { Pool } = require('pg');
const cors = require('cors');

// --- 2. 設定 ---
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});
const DEADLINE_HOUR = 9;

// --- 4. 建立 Express 伺服器和 LINE Bot 用戶端 ---
const app = express();
const client = new line.Client(config);
app.use(cors());
app.use(express.json());

// --- 5. 建立 API ---
app.get('/', (req, res) => {
  res.send('伺服器已啟動！LINE Bot 後端服務運行中。');
});

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// --- 後台管理 API ---
app.get('/admin/suppliers', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM suppliers ORDER BY id');
        res.json(result.rows);
    } catch (error) {
        console.error('取得廠商列表時發生錯誤', error);
        res.status(500).json({ error: '伺服器內部錯誤' });
    }
});

app.post('/admin/suppliers', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: '請提供廠商名稱' });
        const result = await pool.query('INSERT INTO suppliers (name) VALUES ($1) RETURNING *', [name]);
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('新增廠商時發生錯誤', error);
        res.status(500).json({ error: '伺服器內部錯誤' });
    }
});

app.post('/admin/products', async (req, res) => {
  try {
    const { name, price, category, description, image_url, supplier_id } = req.body;
    if (!name || !price || !category || !supplier_id) {
      return res.status(400).json({ error: '名稱、價格、類別和廠商為必填欄位！' });
    }
    const query = `
      INSERT INTO products (name, price, category, description, image_url, supplier_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const values = [name, price, category, description, image_url, supplier_id];
    const result = await pool.query(query, values);
    res.status(201).json({ 
      message: '產品新增成功！', 
      product: result.rows[0] 
    });
  } catch (error) {
    console.error('新增產品時發生錯誤', error);
    res.status(500).json({ error: '伺服器內部錯誤' });
  }
});

app.get('/admin/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, display_name, balance FROM users ORDER BY id');
        res.json(result.rows);
    } catch (error) {
        console.error('取得使用者列表時發生錯誤', error);
        res.status(500).json({ error: '伺服器內部錯誤' });
    }
});

app.post('/admin/users/:id/deposit', async (req, res) => {
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        const userId = parseInt(req.params.id, 10);
        const { amount } = req.body;
        if (!amount || amount <= 0) return res.status(400).json({ error: '請提供有效的儲值金額' });
        const updateResult = await dbClient.query(
            'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING *',
            [amount, userId]
        );
        if (updateResult.rows.length === 0) throw new Error('找不到該使用者');
        const updatedUser = updateResult.rows[0];
        await dbClient.query(
            'INSERT INTO transactions (user_id, type, amount) VALUES ($1, $2, $3)',
            [userId, 'deposit', amount]
        );
        await dbClient.query('COMMIT');
        res.json({ message: '儲值成功', user: updatedUser });
    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error('儲值時發生錯誤', error);
        res.status(500).json({ error: error.message || '伺服器內部錯誤' });
    } finally {
        dbClient.release();
    }
});

app.get('/admin/orders', async (req, res) => {
    try {
        const filterDate = req.query.date || new Date().toLocaleDateString('en-CA');
        const query = `
            SELECT 
                o.id, o.total_amount, o.status, o.created_at, o.order_for_date,
                u.display_name,
                STRING_AGG(p.name, ', ') as items
            FROM orders o
            JOIN users u ON o.user_id = u.id
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            WHERE o.order_for_date = $1
            GROUP BY o.id, u.display_name
            ORDER BY o.created_at DESC;
        `;
        const result = await pool.query(query, [filterDate]);
        res.json(result.rows);
    } catch (error) {
        console.error('取得訂單列表時發生錯誤', error);
        res.status(500).json({ error: '伺服器內部錯誤' });
    }
});

app.get('/admin/menu', async (req, res) => {
    try {
        const { date, supplierId } = req.query;
        if (!date || !supplierId) return res.status(400).json({ error: '請提供日期和廠商ID' });
        
        const allProductsResult = await pool.query('SELECT id, name, price FROM products WHERE supplier_id = $1 ORDER BY id', [supplierId]);
        const menuResult = await pool.query('SELECT product_ids FROM daily_menus WHERE menu_date = $1 AND supplier_id = $2', [date, supplierId]);

        res.json({
            all_products: allProductsResult.rows,
            menu_product_ids: menuResult.rows.length > 0 ? menuResult.rows[0].product_ids : []
        });
    } catch (error) {
        console.error('取得每日菜單時發生錯誤', error);
        res.status(500).json({ error: '伺服器內部錯誤' });
    }
});

app.post('/admin/menu', async (req, res) => {
    try {
        const { date, supplierId, productIds } = req.body;
        if (!date || !supplierId) return res.status(400).json({ error: '請提供日期和廠商ID' });

        const query = `
            INSERT INTO daily_menus (menu_date, supplier_id, product_ids)
            VALUES ($1, $2, $3)
            ON CONFLICT (menu_date, supplier_id)
            DO UPDATE SET product_ids = EXCLUDED.product_ids;
        `;
        await pool.query(query, [date, supplierId, productIds]);
        res.status(200).json({ message: '每日菜單儲存成功' });
    } catch (error) {
        console.error('儲存每日菜單時發生錯誤', error);
        res.status(500).json({ error: '伺服器內部錯誤' });
    }
});


// --- 6. 撰寫事件處理函式 (Event Handler) ---
async function handleEvent(event) {
  const userId = event.source.userId;
  if (event.type === 'follow') return handleFollowEvent(userId, event.replyToken);
  if (event.type === 'postback') {
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');
    if (action === 'select_date') return askForSupplier(event.replyToken, data.get('date'));
    if (action === 'select_supplier') return sendMenuFlexMessage(event.replyToken, data.get('date'), data.get('supplierId'));
    if (action === 'order') return handleOrderAction(userId, parseInt(data.get('productId')), data.get('date'), event.replyToken);
  }
  if (event.type !== 'message' || event.message.type !== 'text') return Promise.resolve(null);
  const userMessage = event.message.text;
  if (userMessage === '菜單' || userMessage === '訂餐') return askForDate(event.replyToken);
  if (userMessage === '餘額' || userMessage === '查詢餘額') return handleCheckBalance(userId, event.replyToken);
  return client.replyMessage(event.replyToken, { type: 'text', text: `你說了：「${userMessage}」` });
}

// --- 7. 處理各種動作的輔助函式 ---
async function handleFollowEvent(userId, replyToken) { /* ... */ }
async function handleOrderAction(userId, productId, orderForDate, replyToken) { /* ... */ }
async function handleCheckBalance(userId, replyToken) { /* ... */ }

async function askForDate(replyToken) {
    const days = [];
    const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    for (let i = 0; i < 5; i++) {
        const date = new Date();
        date.setDate(date.getDate() + i);
        const dateString = date.toLocaleDateString('en-CA');
        const dayOfWeek = weekdays[date.getDay()];
        let label = (i === 0) ? `今天 (${dayOfWeek})` : (i === 1) ? `明天 (${dayOfWeek})` : `${date.getMonth() + 1}/${date.getDate()} (${dayOfWeek})`;
        days.push({
            type: 'button', style: 'primary', height: 'sm', margin: 'sm',
            action: { type: 'postback', label: label, data: `action=select_date&date=${dateString}`, displayText: `我想訂 ${label} 的餐點` }
        });
    }
    const flexMessage = { type: 'flex', altText: '選擇訂餐日期', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg', contents: [{ type: 'text', text: '您想訂哪一天的餐點？', weight: 'bold', size: 'lg' }] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: days } } };
    return client.replyMessage(replyToken, flexMessage);
}

async function askForSupplier(replyToken, forDate) {
    try {
        const result = await pool.query(`SELECT s.id, s.name FROM suppliers s JOIN daily_menus dm ON s.id = dm.supplier_id WHERE dm.menu_date = $1 AND array_length(dm.product_ids, 1) > 0`, [forDate]);
        if (result.rows.length === 0) return client.replyMessage(replyToken, { type: 'text', text: `抱歉，${forDate} 沒有任何廠商提供餐點。` });
        const buttons = result.rows.map(supplier => ({
            type: 'button', style: 'primary', height: 'sm', margin: 'sm',
            action: { type: 'postback', label: supplier.name, data: `action=select_supplier&date=${forDate}&supplierId=${supplier.id}`, displayText: `我想看 ${supplier.name} 的菜單` }
        }));
        const flexMessage = { type: 'flex', altText: '選擇廠商', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg', contents: [{ type: 'text', text: '請問您想訂哪家廠商的餐點？', weight: 'bold', size: 'lg' }] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons } } };
        return client.replyMessage(replyToken, flexMessage);
    } catch (error) {
        console.error('詢問廠商時發生錯誤', error);
        return client.replyMessage(replyToken, { type: 'text', text: '查詢廠商時發生錯誤，請稍後再試。' });
    }
}

async function sendMenuFlexMessage(replyToken, forDate, supplierId) {
    const cleanUrl = (url) => { /* ... */ };
    try {
        const menuResult = await pool.query('SELECT product_ids FROM daily_menus WHERE menu_date = $1 AND supplier_id = $2', [forDate, supplierId]);
        if (menuResult.rows.length === 0 || menuResult.rows[0].product_ids.length === 0) return client.replyMessage(replyToken, { type: 'text', text: `抱歉，該廠商在 ${forDate} 沒有提供餐點喔！` });
        const productIds = menuResult.rows[0].product_ids;
        const productsResult = await pool.query('SELECT * FROM products WHERE id = ANY($1::int[]) ORDER BY id', [productIds]);
        if (productsResult.rows.length === 0) return client.replyMessage(replyToken, { type: 'text', text: '哎呀，找不到對應的餐點資料。' });
        const products = productsResult.rows;
        const bubbles = products.map(product => {
            const actionData = `action=order&productId=${product.id}&date=${forDate}`;
            return { type: 'bubble', hero: { type: 'image', url: cleanUrl(product.image_url), size: 'full', aspectRatio: '20:13', aspectMode: 'cover' }, body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: product.name, weight: 'bold', size: 'xl' }, { type: 'box', layout: 'vertical', margin: 'lg', spacing: 'sm', contents: [{ type: 'box', layout: 'baseline', spacing: 'sm', contents: [{ type: 'text', text: '價格', color: '#aaaaaa', size: 'sm', flex: 1 }, { type: 'text', text: `$${product.price}`, wrap: true, color: '#666666', size: 'sm', flex: 5 }] }, { type: 'box', layout: 'baseline', spacing: 'sm', contents: [{ type: 'text', text: '描述', color: '#aaaaaa', size: 'sm', flex: 1 }, { type: 'text', text: product.description || '無', wrap: true, color: '#666666', size: 'sm', flex: 5 }] }] }] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [{ type: 'button', style: 'primary', height: 'sm', action: { type: 'postback', label: '點餐', data: actionData, displayText: `我想要訂一份 ${forDate} 的「${product.name}」` } }], flex: 0 } };
        });
        const flexMessage = { type: 'flex', altText: '這是今日菜單', contents: { type: 'carousel', contents: bubbles } };
        return client.replyMessage(replyToken, flexMessage);
    } catch (error) {
        console.error('查詢菜單時發生嚴重錯誤:', error);
        if (error.originalError && error.originalError.response) console.error('--- LINE API 錯誤回應 (偵錯用) ---\n', JSON.stringify(error.originalError.response.data, null, 2));
        return client.replyMessage(replyToken, { type: 'text', text: '哎呀，查詢菜單失敗了，請回報管理員查看日誌！' });
    }
}

// --- 8. 啟動伺服器 ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上運行`);
});