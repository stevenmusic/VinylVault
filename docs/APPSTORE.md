# 上架 App Store

用 Capacitor 把同一份 `index.html` 包成原生 iOS App。App 內部一樣呼叫 Cloudflare Worker，
所以網頁版和 App 看到的是同一份資料。

> **前置條件**：一台 macOS 電腦、Xcode、以及 Apple Developer Program 會員資格（USD $99/年）。
> 這些步驟必須在你自己的 Mac 上執行。

---

## 1. 建立 iOS 專案

```bash
cd app
npm install
VV_API_BASE="https://vinylvault-api.<你的帳號>.workers.dev" npm run copy:web
npx cap add ios
npx cap sync ios
npx cap open ios          # 開啟 Xcode
```

`app/capacitor.config.json` 已設定好：

| 設定 | 值 |
| --- | --- |
| Bundle ID | `com.stevenmusic.vinylvault`（改成你自己的） |
| App 名稱 | VinylVault |
| 背景色 | `#0C0A07` |

日後網頁改版，重跑一次就好：

```bash
cd app && VV_API_BASE="https://..." npm run sync
```

---

## 2. Worker 要放行 App 的來源

Capacitor 在 iOS 的 WebView 來源是 `capacitor://localhost`。如果你設了 `ALLOWED_ORIGINS`：

```bash
cd worker
npx wrangler secret put ALLOWED_ORIGINS
# https://<你的帳號>.github.io,capacitor://localhost
```

沒設 `ALLOWED_ORIGINS`（預設）就不用管，任何來源都通。

---

## 3. Xcode 設定

1. **Signing & Capabilities** → 選你的 Team，Bundle Identifier 填 `com.你的名字.vinylvault`
2. **General → Deployment Info** → iPhone / iPad、最低版本 iOS 14 以上
3. **App Icon**：把 `assets/icon-1024.png` 拖進 `Assets.xcassets → AppIcon`
   （已經是 1024×1024、不透明、方角，符合 App Store 規定）
4. **Launch Screen**：背景色設 `#0C0A07`，中央放 icon
5. 真機測試：接上 iPhone → Run

---

## 4. App Store Connect 素材清單

到 <https://appstoreconnect.apple.com> → **My Apps** → **+** 建立 App。

| 項目 | 規格 | 建議內容 |
| --- | --- | --- |
| App 名稱 | ≤ 30 字 | VinylVault |
| 副標題 | ≤ 30 字 | 黑膠版本收藏管理 |
| 分類 | — | 主要：音樂；次要：工具程式 |
| App 圖示 | 1024×1024 PNG、不透明、無圓角 | `assets/icon-1024.png` |
| 截圖 6.7" | 1290×2796 | iPhone 15 Pro Max 模擬器截 3–5 張 |
| 截圖 6.5" | 1242×2688 | 同上（可用 6.7" 縮放） |
| 截圖 iPad 12.9"（若支援 iPad） | 2048×2732 | — |
| 關鍵字 | ≤ 100 字元 | 黑膠,唱片,收藏,vinyl,record,collection,LP,限量 |
| 隱私政策網址 | 必填 | 見下方第 5 點 |
| 支援網址 | 必填 | 你的 GitHub repo 網址即可 |

建議的截圖畫面：歌手列表 / 專輯列表 / 版本卡片牆 / 新增版本表單。

**描述範本：**

```
VinylVault 是為黑膠收藏者設計的版本管理工具。

同一張專輯往往有十幾種壓片版本——不同顏色、不同地區、通路獨佔、限量編號。
VinylVault 用「歌手 → 專輯 → 版本」三層結構，把每一個版本的細節記清楚：

• 唱片顏色與色票
• Limited 限量 / Exclusive 獨佔通路標籤
• 發行地區與發行日期
• 限量張數、售價、購買連結
• ❤ Want 想要清單與 ✓ Owned 已收藏狀態

資料存在你自己的雲端資料庫，手機與電腦即時同步。
```

---

## 5. 審核注意事項

Apple 對「只是網頁包一層」的 App 審得比較嚴（Guideline 4.2 Minimum Functionality）。
這個 App 要順利過審，請確保：

- **原生體驗**：已處理 safe-area（瀏海與 Home Indicator）、無橫向捲動、按鈕夠大好按。
- **離線提示**：沒有網路時要有明確訊息，不能整片空白。目前連線失敗會顯示錯誤與「重試」。
- **不要出現外部付費連結**：版本的「購買連結」是導向唱片行的一般商品頁，屬於實體商品，不受 IAP 規範；但描述裡不要寫「在 App 內購買」。
- **測試帳號**：如果你有設 `WRITE_TOKEN`，要在審核備註提供可寫入的設定方式，否則審核人員只能看不能操作。
- **隱私政策**：即使不收集個資也必須提供網址。可在 repo 開一個 `PRIVACY.md` 並用 GitHub Pages 發佈，內容說明：本 App 不收集個人資料，所有資料儲存於使用者自行設定的資料庫。
- **隱私標籤（App Privacy）**：選 **Data Not Collected**。

---

## 6. 送審

```bash
# Xcode
Product → Archive → Distribute App → App Store Connect → Upload
```

上傳後在 App Store Connect 選版本 → 填素材 → **Submit for Review**。
第一次通常 1–3 天有結果。

---

## 7. Android（選用）

```bash
cd app
npm install @capacitor/android
npx cap add android
npx cap sync android
npx cap open android
```

Google Play 的審核相對寬鬆，素材需求：512×512 圖示、1024×500 橫幅、至少 2 張截圖。
