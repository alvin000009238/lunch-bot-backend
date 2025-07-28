// --- 1. 引入需要的套件 ---
const express = require('express');
const line = require('@line/bot-sdk');
const { Pool } = require('pg');
const cors = require('cors'); // <--- 引入 cors 套件

// --- 2. 設定 ... (省略) ---
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

// --- 4. 建立 Express 伺服器和 LINE Bot 用戶端 ---
const app = express();
const client = new line.Client(config);

// --- (重要修正) 啟用 CORS ---
// 這會允許來自任何來源的請求，包含您本機的 admin.html
app.use(cors());

// --- 5. 建立 API ---
app.get('/', (req, res) => {
  res.send('伺服器已啟動！LINE Bot 後端服務運行中。');
});

// Webhook 路由
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


// --- 後台管理 API ---
app.post('/admin/products', express.json(), async (req, res) => { /* ... 省略，維持不變 ... */ });
app.get('/admin/users', async (req, res) => { /* ... 省略，維持不變 ... */ });
app.post('/admin/users/:id/deposit', express.json(), async (req, res) => { /* ... 省略，維持不變 ... */ });


// --- 6. 撰寫事件處理函式 (Event Handler) ---
// ... handleEvent 函式維持不變 ...


// --- 7. 處理各種動作的輔助函式 ---
// ... handleFollowEvent, handleOrderAction, sendMenuFlexMessage 維持不變 ...


// --- 8. 啟動伺服器 ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上運行`);
});
