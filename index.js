/*
 * =================================================================
 * == 檔案: index.js (增強偵錯日誌版)
 * =================================================================
 * 在最上方加入了全域錯誤捕獲和詳細的啟動日誌，
 * 以偵測可能導致健康檢查失敗的隱藏錯誤。
 */
// --- (新增) 全域錯誤捕獲 ---
console.log(">>> [DEBUG] Script starting...");
process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1); // 強制結束程式，讓錯誤在日誌中變得明顯
});
process.on('uncaughtException', (err, origin) => {
  console.error(`CRITICAL: Caught exception: ${err}\n` + `Exception origin: ${origin}`);
  process.exit(1);
});
console.log(">>> [DEBUG] Global error handlers attached.");

// --- 1. 引入需要的套件 ---
const express = require('express');
const line = require('@line/bot-sdk');
const { Pool } = require('pg');
const cors = require('cors');
console.log(">>> [DEBUG] Modules imported.");

// --- 2. 設定 ---
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};
console.log(">>> [DEBUG] LINE config created. Access Token Present:", !!config.channelAccessToken);

const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
console.log(">>> [DEBUG] DB Connection String Present:", !!connectionString);

const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});
console.log(">>> [DEBUG] Database pool created.");
const DEADLINE_HOUR = 9;
const COMBO_PRICE = 15;
const DRINKS = ['紅茶', '綠茶', '鮮奶茶'];

// --- 4. 建立 Express 伺服器和 LINE Bot 用戶端 ---
const app = express();
console.log(">>> [DEBUG] Express app created.");

const client = new line.Client(config);
console.log(">>> [DEBUG] LINE client created.");

// --- 5. 建立 API ---
app.get('/', (req, res) => {
  res.send('伺服器已啟動！LINE Bot 後端服務運行中。');
});

// Webhook 路由必須在任何 body-parser (如 express.json()) 之前
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// 在 Webhook 之後，為所有後續的 /admin 路由啟用 cors 和 json 解析
app.use(cors());
app.use(express.json());
console.log(">>> [DEBUG] Middlewares (cors, json) attached.");

// --- 後台管理 API ---
app.get('/admin/daily-menu', async (req, res) => {
    try {
        const { date } = req.query;
        if (!date) return res.status(400).json({ error: '請提供日期' });
        const result = await pool.query('SELECT * FROM menu_items WHERE menu_date = $1 ORDER BY display_order', [date]);
        res.json(result.rows);
    } catch (error) {
        console.error('取得每日菜單時發生錯誤', error);
        res.status(500).json({ error: '伺服器內部錯誤' });
    }
});

app.post('/admin/daily-menu', async (req, res) => {
    const { date, items } = req.body;
    if (!date || !items) return res.status(400).json({ error: '請提供日期和菜單項目' });
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        await dbClient.query('DELETE FROM menu_items WHERE menu_date = $1', [date]);
        for (const item of items) {
            const query = `INSERT INTO menu_items (menu_date, name, price, is_combo_eligible, display_order) VALUES ($1, $2, $3, $4, $5)`;
            await dbClient.query(query, [date, item.name, item.price, item.is_combo_eligible, item.display_order]);
        }
        await dbClient.query('COMMIT');
        res.status(201).json({ message: '每日菜單儲存成功' });
    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error('儲存每日菜單時發生錯誤', error);
        res.status(500).json({ error: '伺服器內部錯誤' });
    } finally {
        dbClient.release();
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
                STRING_AGG(oi.item_name || 
                    CASE 
                        WHEN oi.is_combo THEN '(套餐: ' || oi.selected_drink || ')' 
                        ELSE '' 
                    END, ', ') as items
            FROM orders o
            JOIN users u ON o.user_id = u.id
            JOIN order_items oi ON o.id = oi.order_id
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

app.post('/api/settle-daily-orders', async (req, res) => { /* ... 與之前版本相同 ... */ });
console.log(">>> [DEBUG] Admin API routes defined.");

// --- 6. 撰寫事件處理函式 (Event Handler) ---
async function handleEvent(event) {
  const userId = event.source.userId;
  if (event.type === 'follow') return handleFollowEvent(userId, event.replyToken);
  if (event.type === 'postback') {
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');
    if (action === 'select_date') return sendMenuFlexMessage(event.replyToken, data.get('date'));
    if (action === 'order') return handleOrderAction(userId, parseInt(data.get('menuItemId')), data.get('isCombo') === 'true', null, event.replyToken);
    if (action === 'select_drink') return handleOrderAction(userId, parseInt(data.get('menuItemId')), true, data.get('drink'), event.replyToken);
    if (action === 'cancel_order') return handleCancelOrder(userId, parseInt(data.get('orderId')), event.replyToken);
  }
  if (event.type !== 'message' || event.message.type !== 'text') return Promise.resolve(null);
  const userMessage = event.message.text;
  if (userMessage === '菜單' || userMessage === '訂餐') return askForDate(event.replyToken);
  if (userMessage === '餘額' || userMessage === '查詢餘額') return handleCheckBalance(userId, event.replyToken);
  if (userMessage === '取消') return askToCancelOrder(userId, event.replyToken);
  return client.replyMessage(event.replyToken, { type: 'text', text: `您好，請輸入「菜單」、「餘額」或「取消」。` });
}

// --- 7. 處理各種動作的輔助函式 ---
async function handleFollowEvent(userId, replyToken) { /* ... 與之前版本相同 ... */ }
async function handleOrderAction(userId, menuItemId, isCombo, selectedDrink, replyToken) { /* ... 與之前版本相同 ... */ }
async function handleCheckBalance(userId, replyToken) { /* ... 與之前版本相同 ... */ }
async function askForDate(replyToken) { /* ... 與之前版本相同 ... */ }
async function sendMenuFlexMessage(replyToken, forDate) { /* ... 與之前版本相同 ... */ }
async function askForDrink(replyToken, menuItemId) { /* ... 與之前版本相同 ... */ }
async function askToCancelOrder(userId, replyToken) { /* ... 與之前版本相同 ... */ }
async function handleCancelOrder(userId, orderId, replyToken) { /* ... 與之前版本相同 ... */ }
console.log(">>> [DEBUG] Helper functions defined.");

// --- 8. 啟動伺服器 ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上成功運行`);
});
