/*
 * =================================================================
 * == 檔案: index.js
 * =================================================================
 * ✨ 2025-08-06 更新重點 ✨
 * - 移除 cron 自動排程結算，改為手動觸發。
 * - 新增管理員指令 `結算`，管理員在 LINE 輸入後即可觸發當日結算流程。
 * - `runDailySettlement` 函式已修改，以支援手動觸發並回傳執行結果。
 * - `handleEvent` 函式已更新，加入對 `結算` 指令的處理。
 * - 新增 `handleSettlementCommand` 函式，用於處理結算指令的權限驗證與流程控制。
 */
// --- 1. 引入需要的套件 ---
const express = require('express');
const line = require('@line/bot-sdk');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const vision = require('@google-cloud/vision');

// --- 2. 設定 ---
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false
  }
});
const COMBO_PRICE = 15;
const DRINKS = ['紅茶', '綠茶', '鮮奶茶'];

// --- 4. 建立 Express 伺服器和 LINE Bot / Vision 用戶端 ---
const app = express();
const client = new line.Client(config);
const visionClient = new vision.ImageAnnotatorClient();

// 增加請求大小限制，以容納 Base64 圖片
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// --- 5. 建立 API ---
app.get('/', (req, res) => { res.send('伺服器已啟動！'); });

app.post('/webhook', line.middleware(config), (req, res) => {
  console.log('===== 收到 Webhook 請求 =====');
  console.log('Request Body:', JSON.stringify(req.body, null, 2));
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error('處理事件時發生錯誤。');
      if (err.originalError && err.originalError.response && err.originalError.response.data) {
        console.error('LINE API 錯誤詳情:', JSON.stringify(err.originalError.response.data, null, 2));
      } else {
        console.error('完整錯誤物件:', err);
      }
      res.status(500).end();
    });
});

// ==========================================================
// == 後台管理 API
// ==========================================================

// --- 後台管理 API ---
app.post('/admin/login', (req, res) => {
    const { username, password } = req.body;
    const adminUsername = process.env.ADMIN_USERNAME;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminUsername || !adminPassword) {
        console.error('管理員帳號密碼未在環境變數中設定！');
        return res.status(500).json({ error: '伺服器設定不完整' });
    }
    if (username === adminUsername && password === adminPassword) {
        res.status(200).json({ message: '登入成功' });
    } else {
        res.status(401).json({ error: '無效的使用者名稱或密碼' });
    }
});

app.post('/admin/parse-menu-from-image', async (req, res) => {
    try {
        const { singleItemsImage, comboItemsImage } = req.body;
        if (!singleItemsImage || !comboItemsImage) {
            return res.status(400).json({ error: '必須同時提供單點和套餐的圖片' });
        }

        const [singleResult, comboResult] = await Promise.all([
            visionClient.annotateImage({ image: { content: singleItemsImage }, features: [{ type: 'TEXT_DETECTION' }] }),
            visionClient.annotateImage({ image: { content: comboItemsImage }, features: [{ type: 'TEXT_DETECTION' }] })
        ]);

        const singleDetections = singleResult[0].textAnnotations;
        const comboDetections = comboResult[0].textAnnotations;

        if (!singleDetections || singleDetections.length === 0 || !comboDetections || comboDetections.length === 0) {
            return res.status(404).json({ error: '有圖片無法辨識到任何文字' });
        }
        
        const parsedSingleItems = parseMenuFromAnnotations(singleDetections, false);
        const parsedComboItems = parseMenuFromAnnotations(comboDetections, true);

        const finalMenu = [];
        parsedSingleItems.slice(0, 8).forEach((item, index) => {
            finalMenu.push({ ...item, display_order: index + 1 });
        });
        parsedComboItems.slice(0, 3).forEach((item, index) => {
            finalMenu.push({ ...item, display_order: index + 9 });
        });

        res.json(finalMenu);

    } catch (error) {
        console.error('Vision API 處理失敗:', error);
        res.status(500).json({ error: '解析圖片時發生伺服器錯誤' });
    }
});


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

// --- 後台管理頁面路由 ---
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

// --- 主要邏輯函式 ---

function parseMenuFromAnnotations(detections, isComboEligible) {
    const annotations = detections.slice(1);
    const menuItems = [];
    const lines = {};
    for (const annotation of annotations) {
        const y = (annotation.boundingPoly.vertices[0].y + annotation.boundingPoly.vertices[1].y) / 2;
        let foundLine = false;
        for (const lineY in lines) {
            if (Math.abs(y - lineY) < 10) {
                lines[lineY].push(annotation);
                foundLine = true;
                break;
            }
        }
        if (!foundLine) {
            lines[y] = [annotation];
        }
    }
    for (const lineY in lines) {
        const lineAnnotations = lines[lineY].sort((a, b) => a.boundingPoly.vertices[0].x - b.boundingPoly.vertices[0].x);
        let price = null;
        let priceIndex = -1;
        for (let i = lineAnnotations.length - 1; i >= 0; i--) {
            const text = lineAnnotations[i].description;
            if (/^\d{2,3}$/.test(text) && parseInt(text, 10) > 20 && parseInt(text, 10) < 500) {
                price = parseInt(text, 10);
                priceIndex = i;
                break;
            }
        }
        if (price !== null) {
            let nameParts = [];
            for (let i = 0; i < priceIndex; i++) {
                nameParts.push(lineAnnotations[i].description);
            }
            let name = nameParts.join(' ');
            name = name.replace(/^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮\d\W]+\s*/, '');
            name = name.replace(/\s*\d+卡$/, '').trim();
            name = name.replace(/[|:$]/, '').trim();
            if (isComboEligible) {
                name = name.replace(/\s*\+\s*紅茶/, '').trim();
            }
            if (name.length > 1) {
                menuItems.push({
                    name: name,
                    price: price,
                    is_combo_eligible: isComboEligible
                });
            }
        }
    }
    return menuItems;
}


async function getSetting(key, defaultValue) {
    try {
        const result = await pool.query('SELECT * FROM app_settings WHERE key = $1', [key]);
        if (result.rows.length > 0) {
            return result.rows[0].value;
        }
        return defaultValue;
    } catch (error) {
        console.warn(`無法從資料庫取得設定 '${key}'，使用預設值: ${defaultValue}. 錯誤: ${error.message}`);
        return defaultValue;
    }
}

/**
 * ✨ [已修改] 每日結算函式
 * - 現在會回傳一個包含執行結果的物件 { success, message }
 * - 移除時間檢查，因為改為手動觸發
 * - 增加防呆機制 (重複結算、無訂單)
 */
async function runDailySettlement() {
    const now = new Date();
    const taipeiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const settlementDate = taipeiNow.toLocaleDateString('en-CA');
    const dbClient = await pool.connect();
    try {
        await dbClient.query('BEGIN');

        // 檢查1: 今天是否已經結算過？
        const check = await dbClient.query('SELECT * FROM daily_settlements WHERE settlement_date = $1', [settlementDate]);
        if (check.rows.length > 0) {
            await dbClient.query('ROLLBACK');
            const settledTime = new Date(check.rows[0].created_at).toLocaleString('zh-TW', { hour12: false });
            console.log(`[手動結算] ${settlementDate} 的結算已經執行過了。`);
            return { success: false, message: `今天的結算已經在 ${settledTime} 執行過了。` };
        }
        
        // 檢查2: 今天是否有任何「準備中」的訂單需要結算？
        const preparingOrdersCheck = await dbClient.query("SELECT id FROM orders WHERE order_for_date = $1 AND status = 'preparing' LIMIT 1", [settlementDate]);
        if (preparingOrdersCheck.rows.length === 0) {
             await dbClient.query('ROLLBACK');
             console.log(`[手動結算] ${settlementDate} 沒有需要結算的訂單。`);
             return { success: false, message: `今天 (${settlementDate}) 沒有任何狀態為「準備中」的訂單可以結算。` };
        }
        
        // 取消餘額不足者的訂單
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
        for (const userId of cancelledUserIds) {
            const user = await dbClient.query('SELECT line_user_id FROM users WHERE id = $1', [userId]);
            if(user.rows.length > 0) {
                try {
                    await client.pushMessage(user.rows[0].line_user_id, { type: 'text', text: `很抱歉，因結算時您的帳戶餘額不足，您今日的訂單已被系統自動取消，款項已全數退回您的帳戶。` });
                } catch (pushError) {
                    console.error(`[結算任務] 無法傳送取消訊息給使用者 ${userId}`, pushError);
                }
            }
        }

        // 通知訂單成功者
        const successOrders = await dbClient.query(`SELECT o.user_id, u.line_user_id, u.balance, STRING_AGG(oi.item_name || CASE WHEN oi.is_combo THEN '(套餐-' || oi.selected_drink || ')' ELSE '' END, ', ') as items FROM orders o JOIN users u ON o.user_id = u.id JOIN order_items oi ON o.id = oi.order_id WHERE o.order_for_date = $1 AND o.status = 'preparing' GROUP BY o.user_id, u.line_user_id, u.balance`, [settlementDate]);
        for (const order of successOrders.rows) {
            const message = `您的今日訂單已確認！\n- 品項：${order.items}\n- 您目前的餘額為 ${parseFloat(order.balance).toFixed(0)} 元。`;
            try {
                await client.pushMessage(order.line_user_id, { type: 'text', text: message });
            } catch (pushError) {
                console.error(`[結算任務] 無法傳送成功訊息給使用者 ${order.user_id}`, pushError);
            }
        }
        
        // 產生統計報告
        const summaryResult = await dbClient.query(`SELECT item_name || CASE WHEN is_combo THEN '(套餐)' ELSE '' END as full_item_name, selected_drink, COUNT(*) as count, SUM(price_per_item) as subtotal FROM order_items oi JOIN orders o ON oi.order_id = o.id WHERE o.order_for_date = $1 AND o.status = 'preparing' GROUP BY full_item_name, selected_drink`, [settlementDate]);
        let summaryText;
        if (summaryResult.rows.length > 0) {
            summaryText = `--- ${settlementDate} 訂單統計 ---\n`;
            const drinkSummary = {};
            let totalOrders = 0;
            let totalAmount = 0;
            summaryResult.rows.forEach(row => {
                const orderCount = parseInt(row.count);
                summaryText += `${row.full_item_name}: ${orderCount}份\n`;
                totalOrders += orderCount;
                totalAmount += parseFloat(row.subtotal);
                if (row.selected_drink) {
                    drinkSummary[row.selected_drink] = (drinkSummary[row.selected_drink] || 0) + orderCount;
                }
            });
            summaryText += '\n--- 飲料統計 ---\n';
            let totalDrinks = 0;
            if (Object.keys(drinkSummary).length > 0) {
                for (const drink in drinkSummary) {
                    summaryText += `${drink}: ${drinkSummary[drink]}杯\n`;
                    totalDrinks += drinkSummary[drink];
                }
            } else {
                summaryText += '無\n';
            }
            summaryText += `\n--- 總計 ---\n`;
            summaryText += `總訂單數: ${totalOrders} 份\n`;
            summaryText += `總飲料數: ${totalDrinks} 杯\n`;
            summaryText += `總金額: ${totalAmount} 元`;

        } else {
            summaryText = `--- ${settlementDate} 訂單報告 ---\n\n今日沒有任何成功結算的訂單。`;
        }

        // 發送報告給所有管理員
        const admins = await dbClient.query('SELECT line_user_id FROM users WHERE is_admin = true');
        if (admins.rows.length > 0) {
            const adminIds = admins.rows.map(a => a.line_user_id);
            await client.multicast(adminIds, [{ type: 'text', text: summaryText }]);
        }
        
        // 完成結算
        await dbClient.query("UPDATE orders SET status = 'finished' WHERE order_for_date = $1 AND status = 'preparing'", [settlementDate]);
        await dbClient.query('INSERT INTO daily_settlements (settlement_date, is_broadcasted) VALUES ($1, true)', [settlementDate]);
        await dbClient.query('COMMIT');

        return { success: true, message: `結算完成！統計報告已發送給所有管理員。` };

    } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error(`[結算任務失敗] 結算 ${settlementDate} 時發生錯誤`, error);
        return { success: false, message: `結算失敗，發生內部錯誤，請查看伺服器日誌。` };
    } finally {
        dbClient.release();
    }
}

/**
 * ✨ [新增] 處理「結算」指令的函式
 */
async function handleSettlementCommand(userId, replyToken) {
    try {
        // 驗證使用者是否為管理員
        const userResult = await pool.query('SELECT is_admin FROM users WHERE line_user_id = $1', [userId]);
        if (userResult.rows.length === 0 || !userResult.rows[0].is_admin) {
            return client.replyMessage(replyToken, { type: 'text', text: '您沒有執行此操作的權限。' });
        }

        // 先回覆一個處理中訊息，避免 replyToken 過期
        await client.replyMessage(replyToken, { type: 'text', text: '收到結算指令，正在處理中，請稍候...' });

        // 執行結算邏輯
        const result = await runDailySettlement();

        // 使用 pushMessage 推送最終結果給發起指令的管理員
        // (因為 replyToken 已被使用過)
        return client.pushMessage(userId, { type: 'text', text: result.message });

    } catch (error) {
        console.error('處理結算指令時發生錯誤', error);
        // 發生錯誤時也用 pushMessage 通知
        return client.pushMessage(userId, { type: 'text', text: '處理結算指令時發生未預期的錯誤。' });
    }
}


/**
 * ✨ [已修改] 主事件處理函式
 * - 加入對 `結算` 文字訊息的判斷
 */
async function handleEvent(event) {
    if (event.type === 'follow') {
        return handleFollowEvent(event.source.userId, event.replyToken);
    }
    if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const action = data.get('action');
        if (action === 'select_date') return sendMenuFlexMessage(event.replyToken, data.get('date'));
        if (action === 'order') return handleOrderAction(event.source.userId, parseInt(data.get('menuItemId')), data.get('isCombo') === 'true', null, event.replyToken);
        if (action === 'select_drink') return handleOrderAction(event.source.userId, parseInt(data.get('menuItemId')), true, data.get('drink'), event.replyToken);
        if (action === 'cancel_select_date') return showOrdersByDate(event.source.userId, data.get('date'), event.replyToken);
        if (action === 'cancel_order') return handleCancelOrder(event.source.userId, parseInt(data.get('orderId')), event.replyToken);
    }
    if (event.type !== 'message' || event.message.type !== 'text') return Promise.resolve(null);
    
    const userMessage = event.message.text.trim();
    if (userMessage === '菜單' || userMessage === '訂餐') return askForDate(event.replyToken);
    if (userMessage === '餘額' || userMessage === '查詢餘額') return handleCheckBalance(event.source.userId, event.replyToken);
    if (userMessage === '取消') return askToCancelOrder(event.source.userId, event.replyToken);
    
    // ✨ 新增「結算」指令處理
    if (userMessage === '結算') {
        return handleSettlementCommand(event.source.userId, event.replyToken);
    }
    
    return Promise.resolve(null);
}

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
        if (userResult.rows.length === 0) {
            await dbClient.query('ROLLBACK');
            throw new Error('找不到使用者');
        }
        const user = userResult.rows[0];
        
        let totalAmount;
        if (item.is_combo_eligible) {
            totalAmount = isCombo ? parseFloat(item.price) : parseFloat(item.price) - COMBO_PRICE;
        } else {
            totalAmount = parseFloat(item.price);
        }

        const orderInsertResult = await dbClient.query('INSERT INTO orders (user_id, total_amount, status, order_for_date) VALUES ($1, $2, $3, $4) RETURNING id', [user.id, totalAmount, 'preparing', orderForDate]);
        const orderId = orderInsertResult.rows[0].id;
        
        await dbClient.query('INSERT INTO order_items (order_id, item_name, price_per_item, quantity, is_combo, selected_drink) VALUES ($1, $2, $3, $4, $5, $6)', [orderId, item.name, totalAmount, 1, isCombo, selectedDrink]);
        
        const newBalance = parseFloat(user.balance) - totalAmount;
        await dbClient.query('UPDATE users SET balance = $1 WHERE id = $2', [newBalance, user.id]);
        await dbClient.query('INSERT INTO transactions (user_id, type, amount, related_order_id) VALUES ($1, $2, $3, $4)', [user.id, 'payment', totalAmount, orderId]);
        
        await dbClient.query('COMMIT');
        
        let successText = `訂購「${item.name}」成功！`;
        if (isCombo) successText += ` (套餐-${selectedDrink})`;
        successText += `\n金額: ${totalAmount}\n剩餘餘額: ${newBalance.toFixed(0)}`;

        if (newBalance < 0) {
            const deadlineTime = await getSetting('deadline_time', '09:00');
            successText += `\n\n⚠️提醒：您的餘額已為負數，請記得在訂單截止(${deadlineTime})前儲值，否則訂單將會被取消。`;
        }
        
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
        return client.replyMessage(replyToken, { type: 'text', text: `您目前的餘額為: ${balance}元` });
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
            return {
                type: 'button',
                style: 'primary',
                color: '#dc3545', // 紅色
                height: 'sm',
                margin: 'sm',
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
const port = process.env.PORT || 8080;
const host = '0.0.0.0';

// ✨ [已修改] 移除 cron 排程
app.listen(port, host, () => {
  console.log(`伺服器正在 ${host}:${port} 上成功運行`);
  console.log('每日結算排程已移除，等待管理員從 LINE 手動觸發。');
});
