# apps/desktop

本機 core＋只綁 127.0.0.1 的 HTTP / SSE 伺服器，以及繁體中文的 Web UI（對話列表、串流聊天、批准卡「允許一次／拒絕」、提問卡、執行狀態、淺色／深色、快捷鍵）。

- API 一律需要本機 token（產生後存在資料夾的 `secrets.json`，權限 0600）；檢查 Host／Origin 防 DNS rebinding。
- UI 是純 TypeScript，由伺服器用 Node 的型別剝除即時提供，不需要打包工具；設計 token 來自 `packages/design/tokens.css`。
- 桌面 app（Tauri 2 殼）在 [`apps/desktop-shell`](../desktop-shell/README.md)；不裝 app 時，用任何瀏覽器開啟終端機印出的網址即可。

啟動方式見 [docs/RUNNING.md](../../docs/RUNNING.md)。截圖與重新產生方式見 [docs/screenshots](../../docs/screenshots/README.md)。
