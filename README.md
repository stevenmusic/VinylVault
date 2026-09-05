# VinylVault

黑膠唱片版本收藏庫 — **歌手 → 專輯 → 版本** 三層結構，記錄每張唱片的顏色、限量、獨佔通路、地區、發行日、售價與購買連結，並用 ❤ Want / ✓ Owned 追蹤收藏狀態。

資料存在雲端，手機和電腦看到的是同一份。

```
瀏覽器 / App  ──►  Cloudflare Worker  ──►  Turso (libSQL)
  index.html        worker/src/index.js       db/schema.sql
```

Turso 的 URL 與 Token 只存在 Worker 的環境變數，**永遠不會出現在前端**。

---

## 專案結構

| 路徑 | 用途 |
| --- | --- |
| `index.html` | 完整前端（單檔，無框架、無建置步驟） |
| `config.js` | 前端設定：Worker 網址 |
| `db/schema.sql` | Turso 資料表：`artists` / `albums` / `versions` |
| `db/seed.sql` | 選用的範例資料 |
| `worker/src/index.js` | Cloudflare Worker API（零依賴，直接呼叫 Turso HTTP API） |
| `worker/test/` | Worker 測試，對真實 SQLite 執行 |
| `tools/dev-server.mjs` | 本機開發伺服器，**不需要任何雲端帳號** |
| `app/` | Capacitor 包裝設定（上架 App Store 用） |
| `docs/DEPLOY.md` | 從零到上線的完整步驟 |
| `docs/API.md` | API 路由文件 |
| `docs/APPSTORE.md` | App Store 上架流程與素材清單 |

---

## 馬上試（0 個帳號，30 秒）

```bash
node tools/dev-server.mjs --seed
```

打開 <http://localhost:8787>，按右上角 ⚙ 填入 `http://localhost:8787/api` → 儲存。
資料存在記憶體，關掉就消失，純粹用來看畫面與操作流程。

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

**建立資料表**（瀏覽器直接開這個網址就行，手機也可以）：

```
https://vinylvault-api.<你的帳號>.workers.dev/setup?seed=1
```

看到 `"ok": true` 就完成了。`?seed=1` 會順便放一筆範例資料，不需要就去掉。
這支可以重複執行，不會弄壞既有資料。

### 3. GitHub Pages

`Settings → Pages → Source: GitHub Actions`（repo 已內含 `.github/workflows/pages.yml`，推到 `main` 就自動部署）。

接著把 `config.js` 的 `apiBase` 換成你的 Worker 網址並 commit，或直接在 App 裡按 ⚙ 填寫（存在瀏覽器本機）。

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
