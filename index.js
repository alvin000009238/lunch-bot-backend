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

// 啟用 CORS，允許來自所有來源的請求
app.use(cors());

// --- 5. 建立 API ---

// 根目錄，用來確認伺服器狀態
app.get('/', (req, res) => {
  res.send('伺服器已啟動！LINE Bot 後端服務運行中。');
});

// LINE Webhook 路由
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

// 使用 express.json() 來解析傳入的 JSON 請求
app.use(express.json());

// 新增產品
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

// 取得所有使用者
app.get('/admin/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, display_name, balance FROM users ORDER BY id');
        res.json(result.rows);
    } catch (error) {
        console.error('取得使用者列表時發生錯誤', error);
        res.status(500).json({ error: '伺服器內部錯誤' });
    }
});

// 為使用者儲值
app.post('/admin/users/:id/deposit', async (req, res) => {
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        const userId = parseInt(req.params.id, 10);
        const { amount } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({ error: '請提供有效的儲值金額' });
        }

        const updateResult = await dbClient.query(
            'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING *',
            [amount, userId]
        );

        if (updateResult.rows.length === 0) {
            throw new Error('找不到該使用者');
        }
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

// 取得所有訂單
app.get('/admin/orders', async (req, res) => {
    try {
        const query = `
            SELECT 
                o.id,
                o.total_amount,
                o.status,
                o.created_at,
                u.display_name,
                STRING_AGG(p.name, ', ') as items
            FROM orders o
            JOIN users u ON o.user_id = u.id
            JOIN order_items oi ON o.id = oi.order_id
            JOIN products p ON oi.product_id = p.id
            GROUP BY o.id, u.display_name
            ORDER BY o.created_at DESC;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) {
        console.error('取得訂單列表時發生錯誤', error);
        res.status(500).json({ error: '伺服器內部錯誤' });
    }
});


// --- 6. 撰寫事件處理函式 (Event Handler) ---
async function handleEvent(event) {
  const userId = event.source.userId;

  // 處理加入好友事件
  if (event.type === 'follow') {
    return handleFollowEvent(userId, event.replyToken);
  }

  // 處理 Postback 事件
  if (event.type === 'postback') {
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');

    if (action === 'order') {
      const productId = parseInt(data.get('productId'), 10);
      return handleOrderAction(userId, productId, event.replyToken);
    }
  }

  // 處理訊息事件
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

  // 預設的鸚鵡功能
  const reply = { type: 'text', text: `你說了：「${userMessage}」` };
  return client.replyMessage(event.replyToken, reply);
}

// --- 7. 處理各種動作的輔助函式 ---

async function handleFollowEvent(userId, replyToken) {
  try {
    const userCheck = await pool.query('SELECT * FROM users WHERE line_user_id = $1', [userId]);
    if (userCheck.rows.length > 0) {
      return Promise.resolve(null);
    }
    const profile = await client.getProfile(userId);
    await pool.query('INSERT INTO users (line_user_id, display_name) VALUES ($1, $2)', [userId, profile.displayName]);
    const welcomeMessage = {
      type: 'text',
      text: `歡迎 ${profile.displayName}！您已成功註冊午餐訂餐服務，可以開始使用「菜單」指令囉！`
    };
    return client.replyMessage(replyToken, welcomeMessage);
  } catch (error) {
    console.error('處理 follow 事件時發生錯誤', error);
    return Promise.resolve(null);
  }
}

async function handleOrderAction(userId, productId, replyToken) {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');

    const userResult = await dbClient.query('SELECT id, balance FROM users WHERE line_user_id = $1', [userId]);
    const productResult = await dbClient.query('SELECT price, name FROM products WHERE id = $1', [productId]);

    if (userResult.rows.length === 0 || productResult.rows.length === 0) {
      throw new Error('找不到使用者或產品');
    }

    const user = userResult.rows[0];
    const product = productResult.rows[0];

    if (parseFloat(user.balance) < parseFloat(product.price)) {
      await dbClient.query('ROLLBACK');
      return client.replyMessage(replyToken, { type: 'text', text: '餘額不足！請先儲值。' });
    }

    const orderInsertResult = await dbClient.query(
      'INSERT INTO orders (user_id, total_amount, status) VALUES ($1, $2, $3) RETURNING id',
      [user.id, product.price, 'preparing']
    );
    const orderId = orderInsertResult.rows[0].id;

    await dbClient.query(
      'INSERT INTO order_items (order_id, product_id, quantity, price_per_item) VALUES ($1, $2, $3, $4)',
      [orderId, productId, 1, product.price]
    );

    const newBalance = parseFloat(user.balance) - parseFloat(product.price);
    await dbClient.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, user.id]);

    await dbClient.query(
      'INSERT INTO transactions (user_id, type, amount, related_order_id) VALUES ($1, $2, $3, $4)',
      [user.id, 'payment', product.price, orderId]
    );

    await dbClient.query('COMMIT');

    const successMessage = {
      type: 'text',
      text: `訂購「${product.name}」成功！\n訂單編號: ${orderId}\n消費金額: $${product.price}\n剩餘餘額: $${newBalance.toFixed(2)}`
    };
    return client.replyMessage(replyToken, successMessage);

  } catch (error) {
    await dbClient.query('ROLLBACK');
    console.error('處理訂單時發生錯誤', error);
    return client.replyMessage(replyToken, { type: 'text', text: '訂購失敗，發生未預期的錯誤。' });
  } finally {
    dbClient.release();
  }
}

async function sendMenuFlexMessage(replyToken) {
  try {
    const result = await pool.query('SELECT * FROM products WHERE is_available = true ORDER BY id');
    if (result.rows.length === 0) {
      return client.replyMessage(replyToken, { type: 'text', text: '目前沒有可訂購的餐點喔！' });
    }

    const bubbles = result.rows.map(product => ({
      type: 'bubble',
      hero: {
        type: 'image',
        url: product.image_url || '[https://placehold.co/600x400/EFEFEF/AAAAAA?text=No+Image](https://placehold.co/600x400/EFEFEF/AAAAAA?text=No+Image)',
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

async function handleCheckBalance(userId, replyToken) {
  try {
      const result = await pool.query('SELECT balance FROM users WHERE line_user_id = $1', [userId]);
      if (result.rows.length === 0) {
          return client.replyMessage(replyToken, { type: 'text', text: '找不到您的帳戶資料，請嘗試重新加入好友。' });
      }
      const balance = parseFloat(result.rows[0].balance).toFixed(2);
      return client.replyMessage(replyToken, { type: 'text', text: `您目前的餘額為: $${balance}` });
  } catch (error) {
      console.error('查詢餘額時發生錯誤', error);
      return client.replyMessage(replyToken, { type: 'text', text: '查詢餘額失敗，請稍後再試。' });
  }
}

// --- 8. 啟動伺服器 ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上運行`);
});
