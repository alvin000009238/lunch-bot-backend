/*
 * =================================================================
 * == 檔案: index.js (最終完整版)
 * =================================================================
 * 整合了每日限定菜單、自動結算、取消訂單、賒帳等所有功能。
 */
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
const COMBO_PRICE = 15;
const DRINKS = ['紅茶', '綠茶', '鮮奶茶'];

// --- 4. 建立 Express 伺服器和 LINE Bot 用戶端 ---
const app = express();
const client = new line.Client(config);

// --- 5. 建立 API ---
app.get('/', (req, res) => { res.send('伺服器已啟動！'); });

// Webhook 路由必須在任何 body-parser (如 express.json()) 之前
app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then((result) => res.json(result)).catch((err) => {
    console.error(err);
    res.status(500).end();
  });
});

// 在 Webhook 之後，為所有後續的 /admin 路由啟用 cors 和 json 解析
app.use(cors());
app.use(express.json());

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

// --- 自動結算 API ---
app.post('/api/settle-daily-orders', async (req, res) => {
    const { date } = req.body;
    const settlementDate = date || new Date().toLocaleDateString('en-CA');
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        const check = await dbClient.query('SELECT * FROM daily_settlements WHERE settlement_date = $1', [settlementDate]);
        if (check.rows.length > 0) {
            await dbClient.query('ROLLBACK');
            return res.status(200).send('今日已結算');
        }

        // 1. 清理負餘額訂單
        const negativeUsers = await dbClient.query('SELECT id FROM users WHERE balance < 0');
        const cancelledUserIds = new Set();
        if (negativeUsers.rows.length > 0) {
            const userIds = negativeUsers.rows.map(u => u.id);
            const ordersToCancel = await dbClient.query('SELECT id, user_id, total_amount FROM orders WHERE order_for_date = $1 AND user_id = ANY($2::int[]) AND status = $3', [settlementDate, userIds, 'preparing']);
            for (const order of ordersToCancel.rows) {
                await dbClient.query('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled_by_system', order.id]);
                await dbClient.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [order.total_amount, order.user_id]);
                await dbClient.query('INSERT INTO transactions (user_id, type, amount, related_order_id) VALUES ($1, $2, $3, $4)', [order.user_id, 'refund', order.total_amount, order.id]);
                cancelledUserIds.add(order.user_id);
            }
        }
        
        // 2. 發送個人化通知
        const successOrders = await dbClient.query(`SELECT o.user_id, u.line_user_id, u.balance, STRING_AGG(oi.item_name || CASE WHEN oi.is_combo THEN '(套餐-' || oi.selected_drink || ')' ELSE '' END, ', ') as items FROM orders o JOIN users u ON o.user_id = u.id JOIN order_items oi ON o.id = oi.order_id WHERE o.order_for_date = $1 AND o.status = $2 GROUP BY o.user_id, u.line_user_id, u.balance`, [settlementDate, 'preparing']);
        for (const order of successOrders.rows) {
            const message = `訂餐成功！\n您今天訂購了：${order.items}\n您目前的餘額為 ${parseFloat(order.balance).toFixed(0)} 元。`;
            await client.pushMessage(order.line_user_id, { type: 'text', text: message });
        }
        for (const userId of cancelledUserIds) {
            const user = await dbClient.query('SELECT line_user_id FROM users WHERE id = $1', [userId]);
            if(user.rows.length > 0) await client.pushMessage(user.rows[0].line_user_id, { type: 'text', text: '因餘額不足，您今天的訂單已被自動取消，款項已退回。' });
        }

        // 3. 統計並發送結算報告給管理員
        const summaryResult = await dbClient.query(`SELECT item_name || CASE WHEN is_combo THEN '(套餐)' ELSE '' END as full_item_name, selected_drink, COUNT(*) as count FROM order_items oi JOIN orders o ON oi.order_id = o.id WHERE o.order_for_date = $1 AND o.status = 'preparing' GROUP BY full_item_name, selected_drink`, [settlementDate]);
        let summaryText = `--- ${settlementDate} 訂單統計 ---\n`;
        const drinkSummary = {};
        summaryResult.rows.forEach(row => {
            const orderCount = parseInt(row.count);
            summaryText += `${row.full_item_name}: ${orderCount}份\n`;
            if (row.selected_drink) {
                drinkSummary[row.selected_drink] = (drinkSummary[row.selected_drink] || 0) + orderCount;
            }
        });
        summaryText += '\n--- 飲料統計 ---\n';
        for (const drink in drinkSummary) {
            summaryText += `${drink}: ${drinkSummary[drink]}杯\n`;
        }

        const admins = await dbClient.query('SELECT line_user_id FROM users WHERE is_admin = true');
        if (admins.rows.length > 0) {
            const adminIds = admins.rows.map(a => a.line_user_id);
            if(summaryResult.rows.length > 0) await client.multicast(adminIds, [{ type: 'text', text: summaryText }]);
        }

        await dbClient.query('INSERT INTO daily_settlements (settlement_date, is_broadcasted) VALUES ($1, true)', [settlementDate]);
        await dbClient.query('COMMIT');
        res.status(200).send('結算完成');
    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error('結算時發生錯誤', error);
        res.status(500).send('結算失敗');
    } finally {
        dbClient.release();
    }
});

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
async function handleFollowEvent(userId, replyToken) {
    try {
        const userCheck = await pool.query('SELECT * FROM users WHERE line_user_id = $1', [userId]);
        if (userCheck.rows.length > 0) return Promise.resolve(null);
        const profile = await client.getProfile(userId);
        await pool.query('INSERT INTO users (line_user_id, display_name) VALUES ($1, $2)', [userId, profile.displayName]);
        const welcomeMessage = { type: 'text', text: `歡迎 ${profile.displayName}！您已成功註冊午餐訂餐服務。` };
        return client.replyMessage(replyToken, welcomeMessage);
    } catch (error) {
        console.error('處理 follow 事件時發生錯誤', error);
    }
}

async function handleOrderAction(userId, menuItemId, isCombo, selectedDrink, replyToken) {
    const dbClient = await pool.connect();
    try {
        const menuItemResult = await dbClient.query('SELECT * FROM menu_items WHERE id = $1', [menuItemId]);
        if (menuItemResult.rows.length === 0) throw new Error('找不到該餐點');
        const item = menuItemResult.rows[0];
        const orderForDate = new Date(item.menu_date).toLocaleDateString('en-CA');

        const now = new Date();
        const taipeiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        if (new Date(orderForDate).toDateString() === taipeiNow.toDateString() && taipeiNow.getHours() >= DEADLINE_HOUR) {
            return client.replyMessage(replyToken, { type: 'text', text: '抱歉，今日訂餐已於上午9點截止。' });
        }

        if (item.is_combo_eligible && isCombo && !selectedDrink) {
            return askForDrink(replyToken, menuItemId);
        }

        await dbClient.query('BEGIN');
        const userResult = await dbClient.query('SELECT id, balance FROM users WHERE line_user_id = $1', [userId]);
        if (userResult.rows.length === 0) throw new Error('找不到使用者');
        const user = userResult.rows[0];

        const price = isCombo ? parseFloat(item.price) : parseFloat(item.price) - COMBO_PRICE;
        const totalAmount = price;

        const orderInsertResult = await dbClient.query('INSERT INTO orders (user_id, total_amount, status, order_for_date) VALUES ($1, $2, $3, $4) RETURNING id', [user.id, totalAmount, 'preparing', orderForDate]);
        const orderId = orderInsertResult.rows[0].id;

        await dbClient.query('INSERT INTO order_items (order_id, item_name, price_per_item, quantity, is_combo, selected_drink) VALUES ($1, $2, $3, $4, $5, $6)', [orderId, item.name, price, 1, isCombo, selectedDrink]);

        const newBalance = parseFloat(user.balance) - totalAmount;
        await dbClient.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, user.id]);
        await dbClient.query('INSERT INTO transactions (user_id, type, amount, related_order_id) VALUES ($1, $2, $3, $4)', [user.id, 'payment', totalAmount, orderId]);

        await dbClient.query('COMMIT');

        let successText = `訂購「${item.name}」成功！`;
        if (isCombo) successText += ` (套餐-${selectedDrink})`;
        successText += `\n金額: $${totalAmount}\n剩餘餘額: $${newBalance.toFixed(0)}`;
        if (newBalance < 0) successText += '\n提醒您目前餘額為負，請記得在今日上午9點前儲值喔！';
        
        return client.replyMessage(replyToken, { type: 'text', text: successText });
    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error('處理訂單時發生錯誤', error);
        return client.replyMessage(replyToken, { type: 'text', text: '訂購失敗，發生未預期的錯誤。' });
    } finally {
        dbClient.release();
    }
}

async function handleCheckBalance(userId, replyToken) {
    try {
        const result = await pool.query('SELECT balance FROM users WHERE line_user_id = $1', [userId]);
        if (result.rows.length === 0) return client.replyMessage(replyToken, { type: 'text', text: '找不到您的帳戶資料，請嘗試重新加入好友。' });
        const balance = parseFloat(result.rows[0].balance).toFixed(0);
        return client.replyMessage(replyToken, { type: 'text', text: `您目前的餘額為: $${balance}` });
    } catch (error) {
        console.error('查詢餘額時發生錯誤', error);
        return client.replyMessage(replyToken, { type: 'text', text: '查詢餘額失敗，請稍後再試。' });
    }
}

async function askForDate(replyToken) {
    const days = [];
    const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
    for (let i = 0; i < 5; i++) {
        const date = new Date();
        const taipeiTime = new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        taipeiTime.setDate(taipeiTime.getDate() + i);
        
        const dateString = taipeiTime.toLocaleDateString('en-CA');
        const dayOfWeek = weekdays[taipeiTime.getDay()];
        let label = (i === 0) ? `今天 (${dayOfWeek})` : (i === 1) ? `明天 (${dayOfWeek})` : `${taipeiTime.getMonth() + 1}/${taipeiTime.getDate()} (${dayOfWeek})`;
        days.push({ type: 'button', style: 'primary', height: 'sm', margin: 'sm', action: { type: 'postback', label: label, data: `action=select_date&date=${dateString}`, displayText: `我想訂 ${label} 的餐點` } });
    }
    const flexMessage = { type: 'flex', altText: '選擇訂餐日期', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: 'lg', contents: [{ type: 'text', text: '您想訂哪一天的餐點？', weight: 'bold', size: 'lg' }] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: days } } };
    return client.replyMessage(replyToken, flexMessage);
}

async function sendMenuFlexMessage(replyToken, forDate) {
    try {
        const menuItems = await pool.query('SELECT * FROM menu_items WHERE menu_date = $1 ORDER BY display_order', [forDate]);
        if (menuItems.rows.length === 0) return client.replyMessage(replyToken, { type: 'text', text: `抱歉，${forDate} 尚未提供菜單。` });

        const bubbles = menuItems.rows.map(item => {
            const displayId = item.is_combo_eligible ? `套餐 ${item.display_order - 8}` : `單點 ${item.display_order}`;
            const footerButtons = [];
            if (item.is_combo_eligible) {
                const singlePrice = parseFloat(item.price) - COMBO_PRICE;
                footerButtons.push({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: `僅單點 ($${singlePrice})`, data: `action=order&menuItemId=${item.id}&isCombo=false`, displayText: `我只要單點一份${item.name}` } });
                footerButtons.push({ type: 'button', style: 'primary', height: 'sm', margin: 'sm', action: { type: 'postback', label: `升級套餐 ($${parseFloat(item.price)})`, data: `action=order&menuItemId=${item.id}&isCombo=true`, displayText: `我要一份${item.name}套餐` } });
            } else {
                footerButtons.push({ type: 'button', style: 'primary', height: 'sm', action: { type: 'postback', label: `確認單點 ($${parseFloat(item.price)})`, data: `action=order&menuItemId=${item.id}&isCombo=false`, displayText: `我要一份${item.name}` } });
            }

            return { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [ { type: 'text', text: `${displayId} ${item.name}`, weight: 'bold', size: 'xl' } ] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footerButtons } };
        });

        const flexMessage = { type: 'flex', altText: '這是今日菜單', contents: { type: 'carousel', contents: bubbles } };
        return client.replyMessage(replyToken, flexMessage);
    } catch (error) {
        console.error('查詢菜單時發生錯誤', error);
        return client.replyMessage(replyToken, { type: 'text', text: '哎呀，查詢菜單失敗了。' });
    }
}

async function askForDrink(replyToken, menuItemId) {
    const buttons = DRINKS.map(drink => ({
        type: 'button', style: 'primary', height: 'sm', margin: 'sm',
        action: { type: 'postback', label: drink, data: `action=select_drink&menuItemId=${menuItemId}&drink=${drink}`, displayText: `飲料我選${drink}` }
    }));
    const flexMessage = { type: 'flex', altText: '選擇套餐飲料', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '請選擇您的套餐飲料', weight: 'bold', size: 'lg' }] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons } } };
    return client.replyMessage(replyToken, flexMessage);
}

async function askToCancelOrder(userId, replyToken) {
    try {
        const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })).toLocaleDateString('en-CA');
        const userResult = await pool.query('SELECT id FROM users WHERE line_user_id = $1', [userId]);
        if (userResult.rows.length === 0) return client.replyMessage(replyToken, { type: 'text', text: '找不到您的帳戶資料。' });
        const dbUserId = userResult.rows[0].id;

        const orders = await pool.query("SELECT o.id, o.order_for_date, oi.item_name FROM orders o JOIN order_items oi ON o.id = oi.order_id WHERE o.user_id = $1 AND o.status = 'preparing' AND o.order_for_date >= $2 ORDER BY o.order_for_date", [dbUserId, today]);
        if (orders.rows.length === 0) return client.replyMessage(replyToken, { type: 'text', text: '您目前沒有可以取消的訂單。' });

        const buttons = orders.rows.map(order => {
            const dateLabel = new Date(order.order_for_date).toLocaleDateString('zh-TW');
            return {
                type: 'button', style: 'danger', height: 'sm', margin: 'sm',
                action: { type: 'postback', label: `取消 ${dateLabel} 的 ${order.item_name}`, data: `action=cancel_order&orderId=${order.id}`, displayText: `我要取消訂單 ${order.id}` }
            }
        });
        const flexMessage = { type: 'flex', altText: '選擇要取消的訂單', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '請選擇您要取消的訂單', weight: 'bold', size: 'lg' }] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons } } };
        return client.replyMessage(replyToken, flexMessage);
    } catch (error) {
        console.error('查詢可取消訂單時發生錯誤', error);
        return client.replyMessage(replyToken, { type: 'text', text: '查詢訂單失敗，請稍後再試。' });
    }
}

async function handleCancelOrder(userId, orderId, replyToken) {
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');
        const userResult = await dbClient.query('SELECT id FROM users WHERE line_user_id = $1', [userId]);
        if (userResult.rows.length === 0) throw new Error('找不到使用者');
        const dbUserId = userResult.rows[0].id;

        const orderResult = await dbClient.query('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [orderId, dbUserId]);
        if (orderResult.rows.length === 0) throw new Error('找不到該訂單或權限不足');
        const order = orderResult.rows[0];

        if (order.status !== 'preparing') throw new Error('訂單已處理或已取消，無法操作');

        const now = new Date();
        const taipeiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        if (new Date(order.order_for_date).toDateString() === taipeiNow.toDateString() && taipeiNow.getHours() >= DEADLINE_HOUR) {
            throw new Error('已超過當日訂單的取消時間');
        }

        await dbClient.query('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled_by_user', orderId]);
        await dbClient.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [order.total_amount, dbUserId]);
        await dbClient.query('INSERT INTO transactions (user_id, type, amount, related_order_id) VALUES ($1, $2, $3, $4)', [dbUserId, 'refund', order.total_amount, orderId]);

        await dbClient.query('COMMIT');
        return client.replyMessage(replyToken, { type: 'text', text: `訂單 ${orderId} 已成功取消，款項已退回您的餘額。` });
    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error('取消訂單時發生錯誤', error);
        return client.replyMessage(replyToken, { type: 'text', text: `取消失敗：${error.message}` });
    } finally {
        dbClient.release();
    }
}

// --- 8. 啟動伺服器 ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上成功運行`);
});
