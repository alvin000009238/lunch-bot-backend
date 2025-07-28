// --- 1. 引入需要的套件 ---
const express = require('express');
const line = require('@line/bot-sdk');
const { Pool } = require('pg');

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


// --- 5. 建立 API ---
app.get('/', (req, res) => {
  res.send('伺服器已啟動！LINE Bot 後端服務運行中。');
});

// Webhook 路由必須在任何 body-parser (如 express.json()) 之前
app.post('/webhook', line.middleware(config), (req, res) => {
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

// --- (重要修正) 將 express.json() 中間件放在 Webhook 路由之後 ---
// 這樣它就只會影響到後面定義的 /admin 路由，不會干擾到 /webhook
app.use(express.json());

// --- 後台管理用的 API：新增產品 ---
app.post('/admin/products', async (req, res) => {
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
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;
  let reply = {};

  // (優化) 現在 Bot 同時聽得懂「菜單」和「訂餐」
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

  // 預設的鸚鵡功能
  reply = { type: 'text', text: `你說了：「${userMessage}」` };
  return client.replyMessage(event.replyToken, reply);
}

// --- 7. 啟動伺服器 ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上運行`);
});
