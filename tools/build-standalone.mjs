/**
 * 產生「單一檔案版」的 Worker：worker/dist/worker-standalone.js
 *
 * 把前端網頁直接內嵌成字串，變成一個沒有任何 import 的獨立檔案，
 * 可以整份貼進 Cloudflare 後台的 Edit code 直接 Deploy，
 * 不需要 GitHub 連動、不需要建置流程。
 *
 *   node tools/build-standalone.mjs
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFile(path.join(ROOT, p), 'utf8');

const api = await read('worker/src/api.js');
const html = await read('index.html');
const manifest = await read('manifest.webmanifest');

const TAIL = "/** 純 API（不含前端檔案）—— 測試與本機開發伺服器用這個。 */\nexport default createWorker();\n";
if (!api.includes(TAIL)) throw new Error('worker/src/api.js 的結尾與預期不符，請更新這個腳本');

const out = `/**
 * VinylVault Worker —— 單一檔案版（自動產生，請勿直接編輯）
 *
 * 由 tools/build-standalone.mjs 從 worker/src/api.js + index.html 產生。
 * 用途：直接貼進 Cloudflare 後台的 "Edit code" 就能部署，不需要建置流程。
 * 要修改功能請改 worker/src/api.js，然後重跑：
 *   node tools/build-standalone.mjs
 *
 * 別忘了在 Worker 的 Settings 設定兩個 Secret：
 *   TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
 */

${api.replace(TAIL, '')}
const html = ${JSON.stringify(html)};

const manifest = ${JSON.stringify(manifest)};

export default createWorker({ html, manifest });
`;

await writeFile(path.join(ROOT, 'worker/dist/worker-standalone.js'), out);
console.log('已產生 worker/dist/worker-standalone.js（' + Math.round(out.length / 1024) + ' KB）');
