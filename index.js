/*
 * =================================================================
 * == 檔案: index.js (最終修正版)
 * =================================================================
 * 修正了 express.json() 的順序，確保它在 webhook 路由之後被調用，
 * 從而徹底解決 TypeError 的問題。
 */
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

// --- 5. 建立 API ---
app.get('/', (req, res) => {
  res.send('伺服器已啟動！LINE Bot 後端服務運行中。');
});

// --- (重要修正) Webhook 路由必須在任何 body-parser (如 express.json()) 之前 ---
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// --- 在 Webhook 之後，為所有後續的 /admin 路由啟用 cors 和 json 解析 ---
app.use(cors());
app.use(express.json());

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
async function askForDate(replyToken) { /* ... */ }
async function askForSupplier(replyToken, forDate) { /* ... */ }
async function sendMenuFlexMessage(replyToken, forDate, supplierId) { /* ... */ }

// --- 8. 啟動伺服器 ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上運行`);
});
