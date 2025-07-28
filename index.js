// --- 1. 引入需要的套件 ---
const express = require('express');
const line = require('@line/bot-sdk');
const { Pool } = require('pg');
const cors = require('cors');

// --- 2. 設定與 LINE Developer 後台相關的密鑰 ---
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

// --- 3. 設定資料庫連線 ---
const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});

// --- 4. 建立 Express 伺服器和 LINE Bot 用戶端 ---
const app = express();
const client = new line.Client(config);

app.use(cors());

// --- 5. 建立 API ---
app.get('/', (req, res) => {
  res.send('伺服器已啟動！LINE Bot 後端服務運行中。');
});

app.post('/webhook', line.middleware(config), (req, res) => {
  if (!connectionString) {
    console.error('資料庫連線字串未設定！');
    return res.status(500).send('Server configuration error');
  }
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

app.post('/admin/products', express.json(), async (req, res) => {
  try {
    const { name, price, category, description, image_url } = req.body;
    if (!name || !price || !category) {
      return res.status(400).json({ error: '名稱、價格和類別為必填欄位！' });
    }
    const query = `
      INSERT INTO products (name, price, category, description, image_url, is_available)
      VALUES ($1, $2, $3, $4, $5, true)
      RETURNING *;
    `;
    const values = [name, price, category, description, image_url];
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


// --- 6. 撰寫事件處理函式 (Event Handler) ---
async function handleEvent(event) {
  // --- (新增) 處理加入好友事件 ---
  if (event.type === 'follow') {
    const userId = event.source.userId;
    try {
      // 檢查使用者是否已存在
      const userCheck = await pool.query('SELECT * FROM users WHERE line_user_id = $1', [userId]);
      if (userCheck.rows.length > 0) {
        console.log(`使用者 ${userId} 已存在。`);
        return Promise.resolve(null); // 已存在，不需處理
      }

      // 取得使用者 LINE Profile
      const profile = await client.getProfile(userId);
      
      // 將新使用者存入資料庫
      await pool.query(
        'INSERT INTO users (line_user_id, display_name) VALUES ($1, $2)',
        [userId, profile.displayName]
      );

      console.log(`新使用者 ${profile.displayName} (${userId}) 已註冊。`);

      // 回覆歡迎訊息
      const welcomeMessage = {
        type: 'text',
        text: `歡迎 ${profile.displayName}！您已成功註冊午餐訂餐服務，可以開始使用「菜單」指令囉！`
      };
      return client.replyMessage(event.replyToken, welcomeMessage);

    } catch (error) {
      console.error('處理 follow 事件時發生錯誤', error);
      return Promise.resolve(null);
    }
  }

  // --- 處理訊息事件 ---
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;
  let reply = {};

  if (userMessage === '菜單' || userMessage === '訂餐') {
    try {
      const result = await pool.query('SELECT * FROM products WHERE is_available = true ORDER BY id');
      
      if (result.rows.length === 0) {
        reply = { type: 'text', text: '目前沒有可訂購的餐點喔！' };
      } else {
        let menuText = '--- 今日菜單 ---\n\n';
        result.rows.forEach(product => {
          menuText += `${product.name} - $${product.price}\n`;
        });
        reply = { type: 'text', text: menuText };
      }
    } catch (error) {
      console.error('查詢菜單時發生錯誤', error);
      reply = { type: 'text', text: '哎呀，查詢菜單失敗了，請稍後再試！' };
    }
    return client.replyMessage(event.replyToken, reply);
  }

  reply = { type: 'text', text: `你說了：「${userMessage}」` };
  return client.replyMessage(event.replyToken, reply);
}

// --- 7. 啟動伺服器 ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上運行`);
});
