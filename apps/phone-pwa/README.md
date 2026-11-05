# apps/phone-pwa

手機 PWA（不需上架 App Store，無打包器）：聊天、批准單（底部抽屜）、工人卡片、Space 即時畫面與接手、對話列表、記憶與技能（搜尋、篩選、編輯、確認、忘記、匯出；技能提案底部抽屜與技能列表）、連接與例行工作（依 app 分組的帳號、每個 bot 的權限、例行工作與提前擬好的草稿；Composio key 不經手機）、連接 app 寄送前的確認抽屜、裝置與設定、配對。全部走 Alca Link（端對端加密，會合伺服器只看得到密文）。

- `app/` 原始碼（TypeScript，瀏覽器直接跑 strip 後的 `.js`）；`styles/` 「素 Plain」手機版樣式；`icons/`、`manifest.webmanifest`。
- 建置：`node --disable-warning=ExperimentalWarning apps/phone-pwa/scripts/build.ts [outDir]` → `dist/`（含 service worker，預先快取剛好這些檔案，版本取自內容雜湊）。
- 由自架的會合伺服器一併提供：`pnpm rendezvous --pwa apps/phone-pwa/dist`（見 docs/RUNNING.md）。
- 截圖：`apps/phone-pwa/scripts/shots-plain.ts`（見 [docs/screenshots](../../docs/screenshots/README.md)）。
- 金鑰：WebCrypto 產生不可匯出的 P-256 金鑰存在 IndexedDB；配對時雙方互相釘選。
