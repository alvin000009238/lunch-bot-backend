// --- 1. 引入需要的套件 ---
const express = require('express');
const line = require('@line/bot-sdk');
const { Pool } = require('pg');
const cors = require('cors');

// --- 2. 設定 ... (省略，與之前相同) ---
const config = { /* ... */ };
const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const pool = new Pool({ /* ... */ });

// --- 4. 建立 Express 伺服器和 LINE Bot 用戶端 ---
const app = express();
const client = new line.Client(config);
app.use(cors());

// --- 5. 建立 API ---
app.get('/', (req, res) => { /* ... */ });
app.post('/webhook', line.middleware(config), (req, res) => { /* ... */ });
app.post('/admin/products', express.json(), async (req, res) => { /* ... */ });

// --- (新增) 後台管理 API：取得所有使用者 ---
app.get('/admin/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, display_name, balance FROM users ORDER BY id');
        res.json(result.rows);
    } catch (error) {
        console.error('取得使用者列表時發生錯誤', error);
        res.status(500).json({ error: '伺服器內部錯誤' });
    }
});

// --- (新增) 後台管理 API：為使用者儲值 ---
app.post('/admin/users/:id/deposit', express.json(), async (req, res) => {
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        const userId = parseInt(req.params.id, 10);
        const { amount } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: '請提供有效的儲值金額' });
        }

        // 1. 更新使用者餘額
        const updateResult = await dbClient.query(
            'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING *',
            [amount, userId]
        );

        if (updateResult.rows.length === 0) {
            throw new Error('找不到該使用者');
        }
        const updatedUser = updateResult.rows[0];

        // 2. 新增交易紀錄
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


// --- 6. 撰寫事件處理函式 (Event Handler) ---
async function handleEvent(event) {
    const userId = event.source.userId;
    // ... 處理 follow 和 postback 事件 (省略，與之前相同) ...
    
    // --- 處理訊息事件 ---
    if (event.type !== 'message' || event.message.type !== 'text') {
        return Promise.resolve(null);
    }

    const userMessage = event.message.text;

    if (userMessage === '菜單' || userMessage === '訂餐') {
        return sendMenuFlexMessage(event.replyToken);
    }
    
    // --- (新增) 處理查詢餘額指令 ---
    if (userMessage === '餘額' || userMessage === '查詢餘額') {
        try {
            const result = await pool.query('SELECT balance FROM users WHERE line_user_id = $1', [userId]);
            if (result.rows.length === 0) {
                return client.replyMessage(event.replyToken, { type: 'text', text: '找不到您的帳戶資料，請嘗試重新加入好友。' });
            }
            const balance = parseFloat(result.rows[0].balance).toFixed(2);
            return client.replyMessage(event.replyToken, { type: 'text', text: `您目前的餘額為: $${balance}` });
        } catch (error) {
            console.error('查詢餘額時發生錯誤', error);
            return client.replyMessage(event.replyToken, { type: 'text', text: '查詢餘額失敗，請稍後再試。' });
        }
    }

    // 預設的鸚鵡功能
    const reply = { type: 'text', text: `你說了：「${userMessage}」` };
    return client.replyMessage(event.replyToken, reply);
}

// --- 7. 處理各種動作的輔助函式 ---
// ... handleFollowEvent, handleOrderAction, sendMenuFlexMessage (省略，與之前相同) ...

// --- 8. 啟動伺服器 ---
const port = process.env.PORT || 3000;
app.listen(port, () => { /* ... */ });
