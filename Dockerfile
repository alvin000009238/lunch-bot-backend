# 使用官方的 Node.js 18 作為基礎映像
FROM node:18-slim

# 設定工作目錄
WORKDIR /usr/src/app

# 複製 package.json 和 package-lock.json
COPY package*.json ./

# 安裝專案相依套件
RUN npm install

# 複製所有專案檔案到工作目錄
COPY . .

# 開放 Express 伺服器使用的連接埠 (Railway/Render 會自動偵測，但 GCP 需要明確指定)
# Google Cloud Run 會透過 PORT 環境變數提供，預設是 8080
EXPOSE 8080

# 定義啟動容器時要執行的指令
CMD [ "node", "index.js" ]