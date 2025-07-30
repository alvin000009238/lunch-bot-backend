/*
 * =================================================================
 * == 檔案: index.js (已更新，修正取消流程中的 displayText 問題)
 * =================================================================
 * 1. 在 showOrdersByDate 函式中，移除建立「取消訂單」按鈕時的 displayText 屬性，避免 replyToken 衝突。
 * 2. 在結算流程中，將成功的訂單狀態從 'preparing' 更新為 'finished'。
 */
// --- 1. 引入需要的套件 ---
const express = require('express');
const line = require('@line/bot-sdk');
const { Pool } = require('pg');
const cors = require('cors');
const cron = require('node-cron');

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
const COMBO_PRICE = 15;
const DRINKS = ['紅茶', '綠茶', '鮮奶茶'];

// --- 4. 建立 Express 伺服器和 LINE Bot 用戶端 ---
const app = express();
const client = new line.Client(config);

// --- 5. 建立 API ---
app.get('/', (req, res) => { res.send('伺服器已啟動！'); });

app.post('/webhook', line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent)).then((result) => res.json(result)).catch((err) => {
    console.error(err);
    res.status(500).end();
  });
});

app.use(cors());
app.use(express.json());

// --- 輔助函式：從資料庫取得設定 ---
async function getSetting(key, defaultValue) {
    try {
        const result = await pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
        if (result.rows.length > 0) {
            return result.rows[0].value;
        }
        return defaultValue;
    } catch (error) {
        console.warn(`無法從資料庫取得設定 '${key}'，使用預設值: ${defaultValue}. 錯誤: ${error.message}`);
        return defaultValue;
    }
}

// 將結算邏輯獨立成一個函式
async function runDailySettlement() {
    const now = new Date();
    const taipeiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const settlementDate = taipeiNow.toLocaleDateString('en-CA');

    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');

        const check = await dbClient.query('SELECT * FROM daily_settlements WHERE settlement_date = $1', [settlementDate]);
        if (check.rows.length > 0) {
            await dbClient.query('ROLLBACK');
            console.log(`[排程檢查] 日期 ${settlementDate} 已結算過，跳過。`);
            return;
        }

        const deadlineTime = await getSetting('deadline_time', '09:00');
        const [deadlineHour, deadlineMinute] = deadlineTime.split(':').map(Number);
        const isPastDeadline = taipeiNow.getHours() > deadlineHour || (taipeiNow.getHours() === deadlineHour && taipeiNow.getMinutes() >= deadlineMinute);

        if (!isPastDeadline) {
            await dbClient.query('ROLLBACK');
            console.log(`[排程檢查] 時間未到 (現在 ${taipeiNow.getHours()}:${taipeiNow.getMinutes()} / 截止 ${deadlineTime})，跳過。`);
            return;
        }
        
        console.log(`[結算任務開始] 準備結算日期: ${settlementDate}`);

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
        
        const successOrders = await dbClient.query(`SELECT o.user_id, u.line_user_id, u.balance, STRING_AGG(oi.item_name || CASE WHEN oi.is_combo THEN '(套餐-' || oi.selected_drink || ')' ELSE '' END, ', ') as items FROM orders o JOIN users u ON o.user_id = u.id JOIN order_items oi ON o.id = oi.order_id WHERE o.order_for_date = $1 AND o.status = 'preparing' GROUP BY o.user_id, u.line_user_id, u.balance`, [settlementDate]);
        for (const order of successOrders.rows) {
            const message = `訂餐成功！\n您今天訂購了：${order.items}\n您目前的餘額為 ${parseFloat(order.balance).toFixed(0)} 元。`;
            await client.pushMessage(order.line_user_id, { type: 'text', text: message });
        }
        for (const userId of cancelledUserIds) {
            const user = await dbClient.query('SELECT line_user_id FROM users WHERE id = $1', [userId]);
            if(user.rows.length > 0) await client.pushMessage(user.rows[0].line_user_id, { type: 'text', text: '因餘額不足，您今天的訂單已被自動取消，款項已退回。' });
        }

        const summaryResult = await dbClient.query(`SELECT item_name || CASE WHEN is_combo THEN '(套餐)' ELSE '' END as full_item_name, selected_drink, COUNT(*) as count FROM order_items oi JOIN orders o ON oi.order_id = o.id WHERE o.order_for_date = $1 AND o.status = 'preparing' GROUP BY full_item_name, selected_drink`, [settlementDate]);
        let summaryText;
        if (summaryResult.rows.length > 0) {
            summaryText = `--- ${settlementDate} 訂單統計 ---\n`;
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
        } else {
            summaryText = `--- ${settlementDate} 訂單報告 ---\n\n今日沒有任何成功結算的訂單。`;
        }

        const admins = await dbClient.query('SELECT line_user_id FROM users WHERE is_admin = true');
        if (admins.rows.length > 0) {
            const adminIds = admins.rows.map(a => a.line_user_id);
            await client.multicast(adminIds, [{ type: 'text', text: summaryText }]);
        }

        // (新增) 將所有成功結算的訂單狀態更新為 'finished'
        const updateResult = await dbClient.query(
            "UPDATE orders SET status = 'finished' WHERE order_for_date = $1 AND status = 'preparing'",
            [settlementDate]
        );
        console.log(`[結算流程] 已將 ${updateResult.rowCount} 筆 ${settlementDate} 的成功訂單狀態更新為 'finished'`);


        await dbClient.query('INSERT INTO daily_settlements (settlement_date, is_broadcasted) VALUES ($1, true)', [settlementDate]);
        await dbClient.query('COMMIT');
        console.log(`[結算任務成功] 日期 ${settlementDate} 結算完成`);
    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error(`[結算任務失敗] 結算 ${settlementDate} 時發生錯誤`, error);
    } finally {
        dbClient.release();
    }
}


// --- 後台管理 API ---

app.get('/admin/settings', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM app_settings WHERE key = $1', ['deadline_time']);
        const deadline = result.rows.length > 0 ? result.rows[0].value : '09:00';
        res.json({ deadline_time: deadline });
    } catch (error) {
        if (error.code === '42P01') { 
            try {
                await pool.query('CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT)');
                await pool.query("INSERT INTO app_settings (key, value) VALUES ('deadline_time', '09:00') ON CONFLICT (key) DO NOTHING");
                console.log('成功建立 app_settings 資料表並設定預設值。');
                return res.json({ deadline_time: '09:00' });
            } catch (creationError) {
                 console.error('建立 app_settings 表時發生錯誤', creationError);
                 return res.status(500).json({ error: '伺服器內部錯誤' });
            }
        }
        console.error('取得設定時發生錯誤', error);
        res.status(500).json({ error: '伺服器內部錯誤' });
    }
});

app.post('/admin/settings', async (req, res) => {
    const { deadline_time } = req.body;
    if (!deadline_time || !/^\d{2}:\d{2}$/.test(deadline_time)) {
        return res.status(400).json({ error: '請提供有效的截止時間 (HH:MM 格式)' });
    }
    try {
        const query = `
            INSERT INTO app_settings (key, value) 
            VALUES ('deadline_time', $1) 
            ON CONFLICT (key) 
            DO UPDATE SET value = $1;
        `;
        await pool.query(query, [deadline_time]);
        res.json({ message: '設定儲存成功' });
    } catch (error) {
        console.error('儲存設定時發生錯誤', error);
        res.status(500).json({ error: '伺服器內部錯誤' });
    }
});


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


// --- 6. 撰寫事件處理函式 (Event Handler) ---
async function handleEvent(event) {
    // 增加一個日誌來追蹤收到的事件
    console.log('Received event:', JSON.stringify(event, null, 2));

    const userId = event.source.userId;
    
    if (event.type === 'follow') return handleFollowEvent(userId, event.replyToken);
    
    if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const action = data.get('action');
        
        if (action === 'select_date') return sendMenuFlexMessage(event.replyToken, data.get('date'));
        if (action === 'order') return handleOrderAction(userId, parseInt(data.get('menuItemId')), data.get('isCombo') === 'true', null, event.replyToken);
        if (action === 'select_drink') return handleOrderAction(userId, parseInt(data.get('menuItemId')), true, data.get('drink'), event.replyToken);
        if (action === 'cancel_select_date') return showOrdersByDate(userId, data.get('date'), event.replyToken);
        if (action === 'cancel_order') return handleCancelOrder(userId, parseInt(data.get('orderId')), event.replyToken);
    }
    
    if (event.type !== 'message' || event.message.type !== 'text') return Promise.resolve(null);
    
    const userMessage = event.message.text;
    if (userMessage === '菜單' || userMessage === '訂餐') return askForDate(event.replyToken);
    if (userMessage === '餘額' || userMessage === '查詢餘額') return handleCheckBalance(userId, event.replyToken);
    if (userMessage === '取消') return askToCancelOrder(userId, event.replyToken);
    
    // 如果沒有任何關鍵字匹配，就不回覆，以避免搶走 postback 的 replyToken
    // return client.replyMessage(event.replyToken, { type: 'text', text: `您好，請輸入「菜單」、「餘額」或「取消」。` });
    return Promise.resolve(null);
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

        const deadlineTime = await getSetting('deadline_time', '09:00');
        const [deadlineHour, deadlineMinute] = deadlineTime.split(':').map(Number);

        const now = new Date();
        const taipeiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        
        const isPastDeadline = taipeiNow.getHours() > deadlineHour || (taipeiNow.getHours() === deadlineHour && taipeiNow.getMinutes() >= deadlineMinute);

        if (new Date(orderForDate).toDateString() === taipeiNow.toDateString() && isPastDeadline) {
            return client.replyMessage(replyToken, { type: 'text', text: `抱歉，今日訂餐已於 ${deadlineTime} 截止。` });
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
        successText += `\n金額: ${totalAmount}\n剩餘餘額: ${newBalance.toFixed(0)}`;
        if (newBalance < 0) successText += `\n提醒您目前餘額為負，請記得在今日 ${deadlineTime} 前儲值喔！`;
        
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
        return client.replyMessage(replyToken, { type: 'text', text: `您目前的餘額為: ${balance}` });
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
        days.push({ type: 'button', style: 'primary', height: 'sm', margin: 'sm', action: { type: 'postback', label: label, data: `action=select_date&date=${dateString}` } });
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
                footerButtons.push({ type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: `僅單點 (${singlePrice})`, data: `action=order&menuItemId=${item.id}&isCombo=false` } });
                footerButtons.push({ type: 'button', style: 'primary', height: 'sm', margin: 'sm', action: { type: 'postback', label: `升級套餐 (${parseFloat(item.price)})`, data: `action=order&menuItemId=${item.id}&isCombo=true` } });
            } else {
                footerButtons.push({ type: 'button', style: 'primary', height: 'sm', action: { type: 'postback', label: `確認單點 (${parseFloat(item.price)})`, data: `action=order&menuItemId=${item.id}&isCombo=false` } });
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
        action: { type: 'postback', label: drink, data: `action=select_drink&menuItemId=${menuItemId}&drink=${drink}` }
    }));
    const flexMessage = { type: 'flex', altText: '選擇套餐飲料', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '請選擇您的套餐飲料', weight: 'bold', size: 'lg' }] }, footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons } } };
    return client.replyMessage(replyToken, flexMessage);
}

async function askToCancelOrder(userId, replyToken) {
    try {
        const today = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })).toLocaleDateString('en-CA');
        const userResult = await pool.query('SELECT id FROM users WHERE line_user_id = $1', [userId]);
        if (userResult.rows.length === 0) {
            return client.replyMessage(replyToken, { type: 'text', text: '找不到您的帳戶資料。' });
        }
        const dbUserId = userResult.rows[0].id;

        const query = `
            SELECT o.order_for_date, COUNT(*) as order_count, SUM(o.total_amount) as total_amount
            FROM orders o 
            WHERE o.user_id = $1 AND o.status = 'preparing' AND o.order_for_date >= $2 
            GROUP BY o.order_for_date ORDER BY o.order_for_date LIMIT 5;
        `;
        
        const orderDates = await pool.query(query, [dbUserId, today]);
        
        if (orderDates.rows.length === 0) {
            return client.replyMessage(replyToken, { type: 'text', text: '您目前沒有可以取消的訂單。\n（只有狀態為「準備中」的訂單可以取消）' });
        }

        const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
        const buttons = orderDates.rows.map(dateRow => {
            const date = new Date(dateRow.order_for_date);
            const dayOfWeek = weekdays[date.getDay()];
            const dateString = date.toLocaleDateString('en-CA');
            const displayDate = date.toLocaleDateString('zh-TW');
            
            let label;
            if (dateString === today) {
                label = `今天 (${dayOfWeek})`;
            } else {
                const tomorrow = new Date(today);
                tomorrow.setDate(tomorrow.getDate() + 1);
                if (dateString === tomorrow.toLocaleDateString('en-CA')) {
                    label = `明天 (${dayOfWeek})`;
                } else {
                    label = `${displayDate} (${dayOfWeek})`;
                }
            }
            
            const buttonText = `${label} - ${parseInt(dateRow.order_count)}筆訂單 (${parseFloat(dateRow.total_amount).toFixed(0)}元)`;
            
            return {
                type: 'button', style: 'secondary', height: 'sm', margin: 'sm',
                action: { type: 'postback', label: buttonText, data: `action=cancel_select_date&date=${dateString}` }
            };
        });
        
        const deadlineTime = await getSetting('deadline_time', '09:00');
        const flexMessage = { 
            type: 'flex', altText: '選擇要取消訂單的日期', 
            contents: { 
                type: 'bubble', 
                body: { 
                    type: 'box', layout: 'vertical', 
                    contents: [
                        { type: 'text', text: '請選擇要取消訂單的日期', weight: 'bold', size: 'lg' },
                        { type: 'text', text: `※ 只能取消今日 ${deadlineTime} 前的訂單`, size: 'sm', color: '#666666', margin: 'md'}
                    ] 
                }, 
                footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons } 
            } 
        };
        
        return client.replyMessage(replyToken, flexMessage);
    } catch (error) {
        console.error('查詢可取消訂單日期時發生錯誤', error);
        return client.replyMessage(replyToken, { type: 'text', text: '查詢訂單失敗，請稍後再試。' });
    }
}

async function showOrdersByDate(userId, selectedDate, replyToken) {
    try {
        const userResult = await pool.query('SELECT id FROM users WHERE line_user_id = $1', [userId]);
        if (userResult.rows.length === 0) return client.replyMessage(replyToken, { type: 'text', text: '找不到您的帳戶資料。' });
        const dbUserId = userResult.rows[0].id;

        const now = new Date();
        const taipeiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        const orderDate = new Date(selectedDate);
        
        const deadlineTime = await getSetting('deadline_time', '09:00');
        const [deadlineHour, deadlineMinute] = deadlineTime.split(':').map(Number);
        
        const isPastDeadline = taipeiNow.getHours() > deadlineHour || (taipeiNow.getHours() === deadlineHour && taipeiNow.getMinutes() >= deadlineMinute);
        
        if (orderDate.toDateString() === taipeiNow.toDateString() && isPastDeadline) {
            return client.replyMessage(replyToken, { type: 'text', text: `已超過當日訂單的取消時間（${deadlineTime} 截止）` });
        }

        const query = `
            SELECT o.id, o.total_amount, o.created_at, o.status,
                   STRING_AGG(oi.item_name || CASE WHEN oi.is_combo THEN '(套餐-' || oi.selected_drink || ')' ELSE '' END, ', ' ORDER BY oi.id) as items
            FROM orders o JOIN order_items oi ON o.id = oi.order_id 
            WHERE o.user_id = $1 AND o.status = 'preparing' AND o.order_for_date = $2 
            GROUP BY o.id, o.total_amount, o.created_at, o.status
            ORDER BY o.created_at DESC LIMIT 10;
        `;
        
        const orders = await pool.query(query, [dbUserId, selectedDate]);
        
        if (orders.rows.length === 0) {
            return client.replyMessage(replyToken, { type: 'text', text: '該日期沒有可以取消的訂單。' });
        }

        const buttons = orders.rows.map(order => {
            const items = (order.items || '未知商品').length > 15 ? (order.items || '未知商品').substring(0, 12) + '...' : (order.items || '未知商品');
            const buttonText = `${items} (${parseFloat(order.total_amount).toFixed(0)}元)`;
            
            // ==========================================================
            // == ✨ 修正點 ✨
            // == 移除了下面 action 物件中的 displayText 屬性
            // ==========================================================
            return {
                type: 'button', style: 'danger', height: 'sm', margin: 'sm',
                action: { type: 'postback', label: buttonText, data: `action=cancel_order&orderId=${order.id}` }
            };
        });

        buttons.push({
            type: 'button', style: 'secondary', height: 'sm', margin: 'md',
            action: { type: 'message', label: '⬅️ 重新選擇日期', text: '取消' }
        });

        const dateDisplay = new Date(selectedDate).toLocaleDateString('zh-TW');
        const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
        const dayOfWeek = weekdays[new Date(selectedDate).getDay()];

        const flexMessage = { 
            type: 'flex', altText: '選擇要取消的訂單', 
            contents: { 
                type: 'bubble', 
                body: { 
                    type: 'box', layout: 'vertical', 
                    contents: [
                        { type: 'text', text: `${dateDisplay} (${dayOfWeek})`, weight: 'bold', size: 'lg' },
                        { type: 'text', text: `共找到 ${orders.rows.length} 筆可取消的訂單`, size: 'sm', color: '#666666', margin: 'sm' }
                    ] 
                }, 
                footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons } 
            } 
        };
        
        return client.replyMessage(replyToken, flexMessage);
    } catch (error) {
        console.error('顯示特定日期訂單時發生錯誤', error);
        return client.replyMessage(replyToken, { type: 'text', text: `查詢訂單失敗，請稍後再試。` });
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
        if (orderResult.rows.length === 0) throw new Error('找不到該訂單或您沒有權限取消此訂單');
        
        const order = orderResult.rows[0];
        if (order.status !== 'preparing') throw new Error(`訂單狀態為「${order.status}」，無法取消。`);

        const now = new Date();
        const taipeiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        const orderDate = new Date(order.order_for_date);
        
        const deadlineTime = await getSetting('deadline_time', '09:00');
        const [deadlineHour, deadlineMinute] = deadlineTime.split(':').map(Number);
        
        const isPastDeadline = taipeiNow.getHours() > deadlineHour || (taipeiNow.getHours() === deadlineHour && taipeiNow.getMinutes() >= deadlineMinute);

        if (orderDate.toDateString() === taipeiNow.toDateString() && isPastDeadline) {
            throw new Error(`已超過當日訂單的取消時間（${deadlineTime} 截止）`);
        }

        await dbClient.query('UPDATE orders SET status = $1 WHERE id = $2', ['cancelled_by_user', orderId]);
        await dbClient.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [order.total_amount, dbUserId]);
        await dbClient.query('INSERT INTO transactions (user_id, type, amount, related_order_id) VALUES ($1, $2, $3, $4)', [dbUserId, 'refund', order.total_amount, orderId]);

        await dbClient.query('COMMIT');
        
        const balanceResult = await dbClient.query('SELECT balance FROM users WHERE id = $1', [dbUserId]);
        const currentBalance = parseFloat(balanceResult.rows[0].balance).toFixed(0);
        
        const successMessage = `✅ 訂單取消成功！\n訂單編號：${orderId}\n退款金額：${parseFloat(order.total_amount).toFixed(0)}\n目前餘額：${currentBalance}`;
        
        return client.replyMessage(replyToken, { type: 'text', text: successMessage });
    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error('取消訂單時發生錯誤', error);
        return client.replyMessage(replyToken, { type: 'text', text: `❌ 取消失敗：${error.message}` });
    } finally {
        dbClient.release();
    }
}


// --- 8. 啟動伺服器 ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上成功運行`);
  
  // 啟動內建排程器
  // 每分鐘檢查一次
  cron.schedule('* * * * *', () => {
    console.log(`[內建排程] 每分鐘檢查一次，當前時間: ${new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })}`);
    runDailySettlement();
  }, {
    scheduled: true,
    timezone: "Asia/Taipei"
  });

});
