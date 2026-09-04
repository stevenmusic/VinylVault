/**
 * VinylVault 前端設定
 *
 * 部署 Cloudflare Worker 後，把下面的 apiBase 換成你的 Worker 網址，例如：
 *   apiBase: 'https://vinylvault-api.你的帳號.workers.dev'
 *
 * 留空也可以 —— App 第一次開啟會請你輸入，之後存在瀏覽器 localStorage。
 */
window.VINYLVAULT_CONFIG = {
  apiBase: '',
  // 若 Worker 有設定 WRITE_TOKEN，這裡填相同的值才能新增/編輯。
  // 注意：寫在這裡等於公開，個人自用或私有部署再填。
  writeToken: '',
};
