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

app.get('/admin/orders', async (req, res) => {
    try {
        const filterDate = req.query.date || new Date().toLocaleDateString('en-CA');
        
        const query = `
            SELECT 
                o.id,
                o.total_amount,
                o.status,
                o.created_at,
                o.order_for_date,
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


// --- 6. 撰寫事件處理函式 (Event Handler) ---
async function handleEvent(event) {
  const userId = event.source.userId;

  if (event.type === 'follow') {
    return handleFollowEvent(userId, event.replyToken);
  }

  if (event.type === 'postback') {
    const data = new URLSearchParams(event.postback.data);
    const action = data.get('action');

    if (action === 'select_date') {
        const selectedDate = data.get('date');
        return sendMenuFlexMessage(event.replyToken, selectedDate);
    }

    if (action === 'order') {
      const productId = parseInt(data.get('productId'), 10);
      const orderForDate = data.get('date');
      return handleOrderAction(userId, productId, orderForDate, event.replyToken);
    }
  }

  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  const userMessage = event.message.text;

  if (userMessage === '菜單' || userMessage === '訂餐') {
    return askForDate(event.replyToken);
  }
  
  if (userMessage === '餘額' || userMessage === '查詢餘額') {
    return handleCheckBalance(userId, event.replyToken);
  }

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

async function handleOrderAction(userId, productId, orderForDate, replyToken) {
  const now = new Date();
  const taipeiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const orderDate = new Date(orderForDate);
  
  if (orderDate.toDateString() === taipeiNow.toDateString() && taipeiNow.getHours() >= DEADLINE_HOUR) {
      return client.replyMessage(replyToken, { type: 'text', text: '抱歉，今日訂餐已於上午9點截止。' });
  }

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
      'INSERT INTO orders (user_id, total_amount, status, order_for_date) VALUES ($1, $2, $3, $4) RETURNING id',
      [user.id, product.price, 'preparing', orderForDate]
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
      text: `訂購「${product.name}」成功！\n用餐日期: ${orderForDate}\n訂單編號: ${orderId}\n消費金額: $${product.price}\n剩餘餘額: $${newBalance.toFixed(2)}`
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

async function sendMenuFlexMessage(replyToken, forDate) {
    const cleanUrl = (url) => {
        const fallbackUrl = '[https://placehold.co/600x400/EFEFEF/AAAAAA?text=No+Image](https://placehold.co/600x400/EFEFEF/AAAAAA?text=No+Image)';
        if (!url) return fallbackUrl;
        const markdownMatch = url.match(/\((https?:\/\/[^\s)]+)\)/);
        if (markdownMatch && markdownMatch[1]) return markdownMatch[1];
        const plainMatch = url.match(/https?:\/\/[^\s)]+/);
        if (plainMatch) return plainMatch[0];
        return fallbackUrl;
    };

  try {
    const result = await pool.query('SELECT * FROM products WHERE is_available = true ORDER BY id');
    if (result.rows.length === 0) {
      return client.replyMessage(replyToken, { type: 'text', text: '目前沒有可訂購的餐點喔！' });
    }

    const bubbles = result.rows.map(product => {
        const actionData = `action=order&productId=${product.id}&date=${forDate}`;
        return {
            type: 'bubble',
            hero: {
                type: 'image',
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
                    type: 'button', style: 'primary', height: 'sm',
                    action: {
                        type: 'postback',
                        label: '點餐',
                        data: actionData,
                        displayText: `我想要訂一份 ${forDate} 的「${product.name}」`
                    },
                },
                ],
                flex: 0,
            },
        };
    });

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

async function askForDate(replyToken) {
    const days = [];
    const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

    for (let i = 0; i < 5; i++) {
        const date = new Date();
        date.setDate(date.getDate() + i);
        
        const dateString = date.toLocaleDateString('en-CA');
        const dayOfWeek = weekdays[date.getDay()];
        let label = '';
        if (i === 0) label = `今天 (${dayOfWeek})`;
        else if (i === 1) label = `明天 (${dayOfWeek})`;
        else label = `${date.getMonth() + 1}/${date.getDate()} (${dayOfWeek})`;

        days.push({
            type: 'button',
            action: {
                type: 'postback',
                label: label,
                data: `action=select_date&date=${dateString}`,
                displayText: `我想訂 ${label} 的餐點`
            },
            style: 'primary',
            margin: 'sm',
            height: 'sm'
        });
    }

    const flexMessage = {
        type: 'flex',
        altText: '選擇訂餐日期',
        contents: {
            type: 'bubble',
            body: {
                type: 'box',
                layout: 'vertical',
                contents: [
                    {
                        type: 'text',
                        text: '您想訂哪一天的餐點？',
                        weight: 'bold',
                        size: 'lg'
                    }
                ],
                spacing: 'md',
                paddingAll: 'lg'
            },
            footer: {
                type: 'box',
                layout: 'vertical',
                contents: days,
                spacing: 'sm'
            }
        }
    };
    return client.replyMessage(replyToken, flexMessage);
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
