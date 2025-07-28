// --- 1. 引入需要的套件 (Import Packages) ---
const express = require('express');
const line = require('@line/bot-sdk');

// --- 2. 設定與 LINE Developer 後台相關的密鑰 ---
// !!! 重要：請將 'YOUR_CHANNEL_ACCESS_TOKEN' 和 'YOUR_CHANNEL_SECRET'
//          替換成您在第一步中儲存下來的真實金鑰。
const config = {
  channelAccessToken: 'pkPGWez0DjMCEQg6MYrlmu9yr/kmq3Z6aRDZAud+bX+LxuLJfN13PXtOw7GTYv+ycGw/K6Gt5BFfxA5yssHXxcVu1VyhZY+Q0Fh6M+sZ/OE6mxFLcaDoGX867kr/s17eHKRA3Y5uAj8McHp5kVizjAdB04t89/1O/w1cDnyilFU=',
  channelSecret: '156e26041d257b0e3f9de95912e0b0fb'
};

// --- 3. 建立 Express 伺服器和 LINE Bot 用戶端 ---
const app = express();
const client = new line.Client(config);

// --- 4. 建立第一個 API：根目錄 (/) ---
// 這是一個測試用的 API，用來確認我們的伺服器是否正常啟動。
// 當您在瀏覽器打開 http://localhost:3000 時，會看到 "伺服器已啟動！" 的訊息。
app.get('/', (req, res) => {
  res.send('伺服器已啟動！LINE Bot 後端服務運行中。');
});

// --- 5. 建立核心 API：LINE Webhook (/webhook) ---
// 這個 API 是用來接收所有來自 LINE 平台的請求 (例如：使用者傳送訊息)。
// line.middleware 會自動幫我們驗證請求是否來自 LINE，非常安全。
app.post('/webhook', line.middleware(config), (req, res) => {
  // 透過 Promise.all 處理所有收到的事件
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// --- 6. 撰寫事件處理函式 (Event Handler) ---
// 這個函式會判斷收到的事件類型，並做出相對應的處理。
// 目前我們先做一個簡單的「鸚鵡」功能：使用者傳什麼訊息，我們就回傳什麼訊息。
function handleEvent(event) {
  // 我們只處理訊息事件，並且訊息類型是文字
  if (event.type !== 'message' || event.message.type !== 'text') {
    // 如果不是文字訊息，就先忽略
    return Promise.resolve(null);
  }

  // 建立一個要回覆的訊息物件
  const echo = { type: 'text', text: event.message.text };

  // 使用 client.replyMessage() 將訊息回傳給使用者
  // event.replyToken 是 LINE 給予這次對話的一次性權杖，用來識別要回覆到哪個對話。
  return client.replyMessage(event.replyToken, echo);
}

// --- 7. 啟動伺服器 ---
// 讓伺服器在指定的 port 上開始監聽請求。
// process.env.PORT 是 Railway 這類雲端平台會提供的環境變數，
// 如果在本機端執行，則會使用我們預設的 3000。
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`伺服器正在 http://localhost:${port} 上運行`);
});