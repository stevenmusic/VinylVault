# VinylVault API

Base URL：你的 Worker 網址，例如 `https://vinylvault-api.xxx.workers.dev`

- 全部回傳 JSON。
- 讀取（`GET`）永遠開放。
- 寫入（`POST` / `PATCH` / `DELETE`）在 Worker 有設 `WRITE_TOKEN` 時需要
  `Authorization: Bearer <WRITE_TOKEN>`。
- 錯誤格式：`{ "error": "訊息" }`，搭配 400 / 401 / 404 / 502 狀態碼。

---

## 健康檢查

```
GET /health
→ { "service": "vinylvault-api", "ok": true, "configured": true, "db": "ok" }
```

## 建立資料表

```
GET  /setup            建立 artists / albums / versions 三張表（可重複執行）
GET  /setup?seed=1     順便加入一筆範例資料（資料庫非空時會跳過）
POST /setup            同上
```

回傳：

```json
{ "ok": true, "message": "…", "tables": ["albums","artists","versions"], "seeded": false }
```

有設 `WRITE_TOKEN` 時需驗證。用瀏覽器網址列操作可以帶 `?token=<WRITE_TOKEN>`，
用程式呼叫則帶 `Authorization: Bearer <WRITE_TOKEN>`。

## 統計

```
GET /stats
→ { "artists": 12, "albums": 34, "versions": 88, "want": 21, "owned": 40 }
```

---

## 歌手 `/artists`

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/artists?q=&limit=&offset=` | 列表，附 `album_count` / `version_count` / `owned_count` |
| GET | `/artists/:id` | 單筆 |
| POST | `/artists` | 建立，`name` 必填 |
| PATCH | `/artists/:id` | 部分更新 |
| DELETE | `/artists/:id` | 刪除（連動刪除底下專輯與版本） |

欄位：`name*`、`sort_name`、`country`、`image_url`、`notes`

```bash
curl -X POST https://<worker>/artists \
  -H 'Content-Type: application/json' \
  -d '{"name":"Radiohead","country":"UK"}'
```

---

## 專輯 `/albums`

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/albums?artist_id=&q=` | 列表，附 `artist_name` / `version_count` / `owned_count` / `want_count` |
| GET | `/albums/:id` | 單筆 |
| POST | `/albums` | 建立，`artist_id` + `title` 必填 |
| PATCH | `/albums/:id` | 部分更新 |
| DELETE | `/albums/:id` | 刪除（連動刪除底下版本） |

欄位：`artist_id*`、`title*`、`release_year`、`cover_url`、`label`、`notes`

---

## 版本 `/versions`

| 方法 | 路徑 | 說明 |
| --- | --- | --- |
| GET | `/versions?album_id=&artist_id=&want=1&owned=1&is_limited=1&is_exclusive=1&region=` | 列表，附 `album_title` / `artist_name` |
| GET | `/versions/:id` | 單筆 |
| POST | `/versions` | 建立，`album_id` + `name` 必填 |
| PATCH | `/versions/:id` | 部分更新（Want / Owned 切換就是打這支） |
| DELETE | `/versions/:id` | 刪除 |

欄位：

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `album_id` * | int | 所屬專輯 |
| `name` * | text | 版本名稱，例：Gold Nugget LP |
| `cover_url` | text | 版本封面 |
| `color` | text | 唱片顏色文字 |
| `color_hex` | text | 顏色色票，例 `#C9A24B` |
| `is_limited` | 0/1 | Limited 標籤 |
| `is_exclusive` | 0/1 | Exclusive 標籤 |
| `exclusive_to` | text | 獨佔通路，例：Target |
| `region` | text | 地區，例：US / UK / JP / TW |
| `release_date` | text | `YYYY-MM-DD` |
| `edition_size` | int | 限量張數 |
| `price` | float | 售價 |
| `currency` | text | 幣別，預設 `USD` |
| `buy_url` | text | 購買連結 |
| `want` | 0/1 | ❤ 想要 |
| `owned` | 0/1 | ✓ 已擁有 |
| `notes` | text | 備註 |

切換收藏狀態：

```bash
curl -X PATCH https://<worker>/versions/12 \
  -H 'Content-Type: application/json' \
  -d '{"owned":1,"want":0}'
```
