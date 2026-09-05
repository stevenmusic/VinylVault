/**
 * VinylVault 前端設定
 *
 * apiBase 留空 = 本機模式：資料存在這台裝置的瀏覽器，打開就能用，不需要任何帳號。
 * 想要手機與電腦同步，就把 Cloudflare Worker 的網址填進來，例如：
 *   apiBase: 'https://vinylvault-api.sifan888494.workers.dev'
 * （也可以不改這裡，直接在 App 右上角的 ⚙ 設定裡填。）
 */
window.VINYLVAULT_CONFIG = {
  apiBase: '',
  // 若 Worker 有設定 WRITE_TOKEN，這裡填相同的值才能新增/編輯。
  writeToken: '',
};
