# 從零到上線

三個服務要設定：Turso（資料庫）→ Cloudflare Worker（API）→ GitHub Pages（網站）。
Turso 與 Cloudflare 都需要你本人登入自己的帳號，以下每一步都可以直接複製貼上。

---

## 步驟 1 — Turso 資料庫

### 1.1 註冊

到 <https://turso.tech> 用 GitHub 帳號登入（免費方案就夠：500 個資料庫、9GB 儲存）。

### 1.2 安裝 CLI

```bash
# macOS / Linux
curl -sSfL https://get.tur.so/install.sh | bash

# macOS 也可以用 Homebrew
brew install tursodatabase/tap/turso
```

```bash
turso auth login
```

### 1.3 建立資料庫

```bash
turso db create vinylvault-db
```

> 想指定機房離自己近一點：`turso db create vinylvault-db --location nrt`（東京）。
> 可用代碼：`turso db locations`。

### 1.4 建立資料表

**跳過這步。** Worker 第一次讀取資料時發現沒有資料表，會自動建好，
完全不用碰 SQL Console。（想手動觸發或放範例資料：開 `/setup?seed=1`。）

<details>
<summary>想自己動手建（CLI 或網頁 SQL Console）</summary>

```bash
turso db shell vinylvault-db < db/schema.sql

# 選用：塞入範例資料
turso db shell vinylvault-db < db/seed.sql
```

或打開 Turso 網頁後台 → 選資料庫 → **Studio** 分頁（分頁列可以左右滑），
把 `db/schema.sql` 貼上執行。

確認：

```bash
turso db shell vinylvault-db ".tables"
# artists  albums  versions
```
</details>

### 1.5 取得連線資訊（等一下要貼到 Worker）

```bash
turso db show vinylvault-db --url
# libsql://vinylvault-db-<你的帳號>.turso.io

turso db tokens create vinylvault-db
# eyJhbGciOi... （很長，先存起來）
```

> Token 等同資料庫密碼。**不要**放進 GitHub、不要寫在 `config.js`。

---

## 步驟 2 — Cloudflare Worker

Worker 是唯一碰得到 Turso 憑證的地方；瀏覽器只跟 Worker 說話。

### 2.1 部署

```bash
npx wrangler login          # 會開瀏覽器授權
npx wrangler deploy         # 設定檔 wrangler.toml 在專案根目錄
```

輸出會出現網址：

```
https://vinylvault-api.<你的帳號>.workers.dev
```

### 2.2 設定 Secret

```bash
npx wrangler secret put TURSO_DATABASE_URL   # 貼 1.5 的 libsql:// 網址
npx wrangler secret put TURSO_AUTH_TOKEN     # 貼 1.5 的 token
```

### 2.3 確認

```bash
curl https://vinylvault-api.<你的帳號>.workers.dev/health
# {"service":"vinylvault-api","ok":true,"configured":true,"db":"ok"}
```

`ok: true` 就代表 Worker 連得到 Turso。

### 2.3b 建立資料表

用瀏覽器（手機也行）打開：

```
https://vinylvault-api.<你的帳號>.workers.dev/setup?seed=1
```

回傳：

```json
{"ok":true,"message":"資料表已建立…","tables":["albums","artists","versions"],"seeded":true}
```

- `?seed=1` 會加一筆範例資料，不想要就拿掉。
- 可以重複執行，用的是 `CREATE TABLE IF NOT EXISTS`，不會蓋掉既有資料。
- 如果之後才設 `WRITE_TOKEN`，這支要改成 `/setup?token=<你的WRITE_TOKEN>`。
- 也可以不開網址：在 App 裡如果偵測到沒有資料表，畫面會直接出現「建立資料表」按鈕。

<details>
<summary>不想用指令，改用 Cloudflare 網頁後台</summary>

1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → **Create Worker**
2. 命名 `vinylvault-api` → Deploy
3. **Edit code**，把 `worker/dist/worker-standalone.js` 全文貼上取代預設內容 → Deploy
4. **Settings → Variables and Secrets** → 新增兩個 **Secret**：
   - `TURSO_DATABASE_URL`
   - `TURSO_AUTH_TOKEN`
5. 存檔後重新 Deploy

（這份 Worker 沒有任何 npm 依賴，所以貼上就能跑。）
</details>

### 2.4 上鎖（建議，但可以之後再做）

```bash
npx wrangler secret put WRITE_TOKEN
# 自己想一組長字串，例如用 openssl rand -hex 24 產生

npx wrangler secret put ALLOWED_ORIGINS
# https://<你的 GitHub 帳號>.github.io,capacitor://localhost
```

- `WRITE_TOKEN`：設了之後，`POST` / `PATCH` / `DELETE` 都要帶 `Authorization: Bearer <token>`。前端在 ⚙ 設定裡填同一組即可。
- `ALLOWED_ORIGINS`：限制哪些網站能呼叫這個 API。App（Capacitor）在 iOS 的來源是 `capacitor://localhost`，記得一起加。

### 2.5 本機開發 Worker

```bash
cp .dev.vars.example .dev.vars      # 填入自己的 Turso URL / token
npx wrangler dev                    # → http://localhost:8787
```

---

## 步驟 3 — GitHub Pages

### 3.1 開啟 Pages

Repo → **Settings** → **Pages** → **Source** 選 **GitHub Actions**。

Repo 內已有 `.github/workflows/pages.yml`，推到 `main` 就會自動部署到：

```
https://<你的帳號>.github.io/VinylVault/
```

### 3.2 把 API 網址寫進去

編輯 `config.js`：

```js
window.VINYLVAULT_CONFIG = {
  apiBase: 'https://vinylvault-api.<你的帳號>.workers.dev',
  writeToken: '',
};
```

commit + push 即可。

> 不想把網址寫進 repo？留空也行 —— 第一次打開網站時按右上角 ⚙ 填入，會存在該裝置的 localStorage。
> 也支援用網址帶入：`https://.../VinylVault/?api=https://xxx.workers.dev`

---

## 步驟 4 — 測試清單

| 檢查 | 方法 |
| --- | --- |
| Worker 連得到 Turso | `curl <worker>/health` → `"ok":true` |
| 讀取正常 | `curl <worker>/artists` → `[]` 或資料 |
| 寫入正常 | 在網站上新增一位歌手，重新整理後還在 |
| 跨裝置同步 | 手機打開同一個網址，看得到剛剛新增的資料 |
| CORS 沒設錯 | 瀏覽器 Console 沒有 CORS 紅字 |
| 篩選正常 | 專輯頁切 ❤ Want / ✓ Owned / Limited / 地區 |

---

## 常見問題

**`/health` 回 `"db":"error: ..."`**
Secret 沒設或設錯。`npx wrangler secret list` 確認兩個都在，重設一次再 deploy。

**瀏覽器 Console 出現 CORS 錯誤**
`ALLOWED_ORIGINS` 沒有包含你的網站來源。逗號分隔、要含 `https://`、結尾不要斜線。清空這個變數則允許所有來源。

**新增/編輯時跳出 `Unauthorized`**
Worker 設了 `WRITE_TOKEN`，前端 ⚙ 裡沒填或填錯。

**GitHub Pages 出現 404**
Pages 的 Source 要選 **GitHub Actions**（不是 Deploy from a branch），並確認 Actions 那次 run 是綠燈。

**資料庫改欄位**
直接對 Turso 下 `ALTER TABLE`，然後在 `worker/src/index.js` 的 `VERSION_FIELDS` 之類的白名單加上欄位名，再 `wrangler deploy`。
