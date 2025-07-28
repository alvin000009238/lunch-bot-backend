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

app.use(express.json());

// ... 其他後台 API 維持不變 (省略以保持簡潔) ...
app.post('/admin/products', async (req, res) => { /* ... */ });
app.get('/admin/users', async (req, res) => { /* ... */ });
app.post('/admin/users/:id/deposit', async (req, res) => { /* ... */ });
app.get('/admin/orders', async (req, res) => { /* ... */ });


// --- 6. 撰寫事件處理函式 (Event Handler) ---
async function handleEvent(event) {
  const userId = event.source.userId;

  if (event.type === 'follow') {
    return handleFollowEvent(userId, event.replyToken);
  }
  if (event.type === 'postback') {
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');
    if (action === 'order') {
      const productId = parseInt(data.get('productId'), 10);
      return handleOrderAction(userId, productId, event.replyToken);
    }
  }
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;
  if (userMessage === '菜單' || userMessage === '訂餐') {
    return sendMenuFlexMessage(event.replyToken);
  }
  if (userMessage === '餘額' || userMessage === '查詢餘額') {
    return handleCheckBalance(userId, event.replyToken);
  }

  const reply = { type: 'text', text: `你說了：「${userMessage}」` };
  return client.replyMessage(event.replyToken, reply);
}

// --- 7. 處理各種動作的輔助函式 ---

// ... handleFollowEvent, handleOrderAction, handleCheckBalance 維持不變 (省略) ...

// (重要修正) 發送互動式菜單
async function sendMenuFlexMessage(replyToken) {
  try {
    const result = await pool.query('SELECT * FROM products WHERE is_available = true ORDER BY id');
    if (result.rows.length === 0) {
      return client.replyMessage(replyToken, { type: 'text', text: '目前沒有可訂購的餐點喔！' });
    }

    // (新增) 輔助函式，用來清理不正確的 URL 格式
    const cleanUrl = (url) => {
        const fallbackUrl = 'https://placehold.co/600x400/EFEFEF/AAAAAA?text=No+Image';
        if (!url) return fallbackUrl;
        
        // 嘗試從 Markdown 格式 [text](url) 中提取 URL
        const markdownMatch = url.match(/\((https?:\/\/[^\s)]+)\)/);
        if (markdownMatch && markdownMatch[1]) {
            return markdownMatch[1];
        }

        // 嘗試直接匹配 URL
        const plainMatch = url.match(/https?:\/\/[^\s)]+/);
        if (plainMatch) {
            return plainMatch[0];
        }

        // 如果都找不到，回傳預設圖片
        return fallbackUrl;
    };

    const bubbles = result.rows.map(product => ({
      type: 'bubble',
      hero: {
        type: 'image',
        // (修正) 使用 cleanUrl 函式來處理圖片網址
        url: cleanUrl(product.image_url),
        size: 'full',
        aspectRatio: '20:13',
        aspectMode: 'cover',
      },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: product.name, weight: 'bold', size: 'xl' },
          {
            type: 'box', layout: 'vertical', margin: 'lg', spacing: 'sm',
            contents: [
              {
                type: 'box', layout: 'baseline', spacing: 'sm',
                contents: [
                  { type: 'text', text: '價格', color: '#aaaaaa', size: 'sm', flex: 1 },
                  { type: 'text', text: `$${product.price}`, wrap: true, color: '#666666', size: 'sm', flex: 5 },
                ],
              },
               {
                type: 'box', layout: 'baseline', spacing: 'sm',
                contents: [
                  { type: 'text', text: '描述', color: '#aaaaaa', size: 'sm', flex: 1 },
                  { type: 'text', text: product.description || '無', wrap: true, color: '#666666', size: 'sm', flex: 5 },
                ],
              },
            ],
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          {
            type: 'button', style: 'link', height: 'sm',
            action: {
              type: 'postback',
              label: '點餐',
              data: `action=order&productId=${product.id}`,
              displayText: `我想要點一份「${product.name}」`
            },
          },
        ],
        flex: 0,
      },
    }));

    const flexMessage = {
      type: 'flex',
      altText: '這是今日菜單',
      contents: { type: 'carousel', contents: bubbles },
    };
    return client.replyMessage(replyToken, flexMessage);
  } catch (error) {
    console.error('查詢菜單時發生錯誤', error);
    return client.replyMessage(replyToken, { type: 'text', text: '哎呀，查詢菜單失敗了，請稍後再試！' });
  }
}

// --- 8. 啟動伺服器 ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上運行`);
});
