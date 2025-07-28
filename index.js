// --- 1. 引入需要的套件 ---
const express = require('express');
const line = require('@line/bot-sdk');
const { Pool } = require('pg'); // <--- 新增 pg 套件

// --- 2. 設定與 LINE Developer 後台相關的密鑰 ---
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

// --- 3. 設定資料庫連線 ---
// Railway 會自動提供 DATABASE_URL 這個環境變數
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // 在開發和一些雲端平台上需要這個設定
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
  let reply = {}; // 準備要回覆的訊息物件

  // --- 新功能：處理「菜單」指令 ---
  if (userMessage === '菜單') {
    try {
      // 從資料庫查詢所有 "is_available" 為 true 的商品
      const result = await pool.query('SELECT * FROM products WHERE is_available = true');
      
      if (result.rows.length === 0) {
        reply = { type: 'text', text: '目前沒有可訂購的餐點喔！' };
      } else {
        // 格式化菜單訊息
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

  // 預設的鸚鵡功能
  reply = { type: 'text', text: `你說了：「${userMessage}」` };
  return client.replyMessage(event.replyToken, reply);
}

// --- 7. 啟動伺服器 ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上運行`);
});
