# VinylVault

黑膠唱片版本收藏庫 — **歌手 → 專輯 → 版本** 三層結構，記錄每張唱片的顏色、限量、獨佔通路、地區、發行日、售價與購買連結，並用 ❤ Want / ✓ Owned 追蹤收藏狀態。

## 兩種用法

**① 本機模式（預設，零設定）**
打開網頁就能用，資料存在這台裝置的瀏覽器裡。不需要註冊任何服務、不需要後端。
適合自己一台手機用。記得偶爾在 ⚙ 設定裡「匯出備份」。

**② 雲端模式（跨裝置同步）**
在 ⚙ 設定裡填入 Cloudflare Worker 網址後，資料改存 Turso，手機和電腦看到同一份。

```
瀏覽器 / App  ──►  Cloudflare Worker  ──►  Turso (libSQL)
  index.html        worker/src/api.js        自動建表
```

Turso 的 URL 與 Token 只存在 Worker 的環境變數，**永遠不會出現在前端**。
Worker 本身也會把前端網頁一起送出來，所以部署完直接開 Worker 網址就是 App。

## 專案結構

| 路徑 | 用途 |
| --- | --- |
| `index.html` | 完整前端（單檔，無框架、無建置步驟） |
| `config.js` | 前端設定：Worker 網址 |
| `db/schema.sql` | Turso 資料表：`artists` / `albums` / `versions` |
| `db/seed.sql` | 選用的範例資料 |
| `worker/src/api.js` | Worker 的 API 邏輯（零依賴，直接呼叫 Turso HTTP API） |
| `worker/src/index.js` | Worker 進入點，額外把前端網頁一起打包 |
| `worker/dist/worker-standalone.js` | 單一檔案版，可直接貼進 Cloudflare 後台部署 |
| `worker/test/` | Worker 測試，對真實 SQLite 執行 |
| `tools/dev-server.mjs` | 本機開發伺服器，**不需要任何雲端帳號** |
| `app/` | Capacitor 包裝設定（上架 App Store 用） |
| `docs/DEPLOY.md` | 從零到上線的完整步驟 |
| `docs/API.md` | API 路由文件 |
| `docs/APPSTORE.md` | App Store 上架流程與素材清單 |

---

## 馬上試

直接把 `index.html` 用瀏覽器打開，或部署到 GitHub Pages，就能開始用（本機模式）。

想連著後端一起測（不需要雲端帳號）：

```bash
node tools/dev-server.mjs --seed
```

打開 <http://localhost:8787>，按右上角 ⚙ 填入 `http://localhost:8787/api` → 儲存。
資料存在記憶體，關掉就消失。

---

## 正式部署（三步）

完整版看 [`docs/DEPLOY.md`](docs/DEPLOY.md)，摘要：

### 1. Turso 資料庫

到 <https://turso.tech> 登入 → 建立資料庫 `vinylvault-db` → 抄下 **Database URL** 與 **Token**。

**不用自己建資料表**：Worker 部署好之後開一次 `/setup` 就會自動建好（見下一步）。

想用 CLI 也可以：

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
turso db create vinylvault-db
turso db shell vinylvault-db < db/schema.sql   # 選用，等同 /setup

turso db show vinylvault-db --url          # → libsql://vinylvault-db-xxx.turso.io
turso db tokens create vinylvault-db       # → 一長串 token
```

### 2. Cloudflare Worker

```bash
cd worker
npx wrangler login
npx wrangler deploy
npx wrangler secret put TURSO_DATABASE_URL   # 貼上第 1 步的 URL
npx wrangler secret put TURSO_AUTH_TOKEN     # 貼上第 1 步的 token
```

部署後會得到 `https://vinylvault-api.<你的帳號>.workers.dev`。
**直接用瀏覽器打開它就是 App 本體** —— Worker 會把前端網頁一起送出來，
資料表也會在第一次讀取時自動建立，不必另外做任何事。

想手動建表或放範例資料，可以開 `/setup?seed=1`（可重複執行，不會弄壞既有資料）。

### 3. GitHub Pages（選用）

Worker 網址本身就能用了，這步只是多一個好記的網址。

`Settings → Pages → Source: GitHub Actions`（repo 已內含 `.github/workflows/pages.yml`，推到 `main` 就自動部署）。

`config.js` 的 `apiBase` 已經指向 Worker，不用再設定。

---

## 安全性

- Turso 憑證只在 Worker 端，前端拿不到。
- 預設**任何人都能寫入**（適合自用）。要鎖起來：

```bash
cd worker
npx wrangler secret put WRITE_TOKEN        # 自己設一組長字串
npx wrangler secret put ALLOWED_ORIGINS    # 例：https://你的帳號.github.io
```

設定後，前端在 ⚙ 裡填同一組 `WRITE_TOKEN` 才能新增/編輯/刪除；讀取不受限。

---

## 測試

```bash
cd worker && node --test test/*.test.mjs
```

測試會用 Node 內建 SQLite 模擬 Turso 的 HTTP 介面，完整跑過 CRUD、篩選、CORS 與寫入權杖保護。

---

## 上架 App Store

見 [`docs/APPSTORE.md`](docs/APPSTORE.md)。用 Capacitor 把同一份網頁包成原生 App，App 內部一樣打 Cloudflare Worker，資料互通。
