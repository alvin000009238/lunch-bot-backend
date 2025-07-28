// --- 1. 引入需要的套件 ---
const express = require('express');
const line = require('@line/bot-sdk');
const { Pool } = require('pg');

// --- 2. 設定與 LINE Developer 後台相關的密鑰 ---
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

// --- 3. 設定資料庫連線 (更新) ---
// 優先使用 DATABASE_PUBLIC_URL，如果不存在，則使用 DATABASE_URL
// 這讓我們的程式更有彈性，能適應不同平台的命名
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

// --- 5. 建立 API ---
app.get('/', (req, res) => {
  res.send('伺服器已啟動！LINE Bot 後端服務運行中。');
});

app.post('/webhook', line.middleware(config), (req, res) => {
  // 檢查是否有連線字串，若無則回報錯誤
  if (!connectionString) {
    console.error('資料庫連線字串未設定！請檢查環境變數 DATABASE_PUBLIC_URL 或 DATABASE_URL。');
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

// --- 6. 撰寫事件處理函式 (Event Handler) ---
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;
  let reply = {};

  if (userMessage === '菜單') {
    try {
      const result = await pool.query('SELECT * FROM products WHERE is_available = true');
      
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
