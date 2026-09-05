/**
 * Cloudflare Worker 進入點。
 *
 * 這一層只做一件事：把前端的三個檔案一起打包進 Worker，
 * 讓 https://<你的 worker>.workers.dev 直接打開就是 App 本體。
 * （Wrangler 依 wrangler.toml 的 [[rules]] type = "Text" 把它們當文字模組處理。）
 *
 * 所有 API 邏輯都在 ./api.js。
 */
import html from '../../index.html';
import manifest from '../../manifest.webmanifest';
import { createWorker } from './api.js';

export default createWorker({ html, manifest });
