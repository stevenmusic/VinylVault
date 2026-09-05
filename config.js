/**
 * VinylVault 前端設定
 *
 * apiBase 已填好你的 Cloudflare Worker 網址，正常情況下不用改。
 * 換 Worker 或自己重新部署時，改這一行即可。
 *
 * 也可以留空 —— App 第一次開啟會請你輸入，之後存在瀏覽器 localStorage。
 */
window.VINYLVAULT_CONFIG = {
  apiBase: 'https://vinylvault-api.sifan888494.workers.dev',
  // 若 Worker 有設定 WRITE_TOKEN，這裡填相同的值才能新增/編輯。
  // 注意：寫在這裡等於公開，個人自用或私有部署再填。
  writeToken: '',
};
