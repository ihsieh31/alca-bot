# services/rendezvous（stub）

Alca Link 的會合／轉送服務，**只看得到密文**，使用者可自架。

- 每台桌面一個隨機 128-bit mailbox；只存在線狀態與可選的加密離線信箱（預設 24 小時後刪）。
- 部署：Cloudflare Worker + Durable Object（`wrangler deploy` 到自己帳號），或單一 Docker / Node binary。
- QR 內帶伺服器網址，手機自動跟隨。
- 預計在 P3 實作。
