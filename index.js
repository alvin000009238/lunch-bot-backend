// --- 1. 引入需要的套件 (Import Packages) ---
const express = require('express');
const line = require('@line/bot-sdk');

// --- 2. 設定與 LINE Developer 後台相關的密鑰 ---
// 修改後：從環境變數 process.env 讀取金鑰
const config = {
  channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.CHANNEL_SECRET
};

// --- 3. 建立 Express 伺服器和 LINE Bot 用戶端 ---
const app = express();
const client = new line.Client(config);

// --- 4. 建立第一個 API：根目錄 (/) ---
app.get('/', (req, res) => {
  res.send('伺服器已啟動！LINE Bot 後端服務運行中。');
});

// --- 5. 建立核心 API：LINE Webhook (/webhook) ---
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
function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    return Promise.resolve(null);
  }

  // 檢查是否是指令
  if (event.message.text === '你好') {
      const reply = { type: 'text', text: '你好！我是午餐小幫手。' };
      return client.replyMessage(event.replyToken, reply);
  }

  // 預設的鸚鵡功能
  const echo = { type: 'text', text: `你說了：「${event.message.text}」` };
  return client.replyMessage(event.replyToken, echo);
}

// --- 7. 啟動伺服器 ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上運行`);
});
