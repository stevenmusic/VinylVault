/**
 * 本機開發伺服器 —— 不需要 Turso / Cloudflare 帳號就能先玩前端。
 *
 *   node tools/dev-server.mjs        # http://localhost:8787
 *   node tools/dev-server.mjs --empty  # 空資料庫，測試 App 內的「建立資料表」按鈕
 *
 * 它做兩件事：
 *   1. 靜態服務專案根目錄（index.html 等）
 *   2. 把 /api/* 交給真正的 Worker 程式碼處理，資料存在記憶體 SQLite
 *      （用 worker/test/turso-mock.mjs 模擬 Turso 的 HTTP 介面）
 *
 * 打開後在「⚙ 設定」填 http://localhost:8787/api 即可。
 * 加上 --seed 會載入 db/seed.sql 的範例資料。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createMockTurso } from '../worker/test/turso-mock.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 8787);

// --empty：模擬「Turso 剛建好、還沒有資料表」的狀態，用來測 /setup 流程
globalThis.fetch = createMockTurso({ schema: !process.argv.includes('--empty') });
const worker = (await import('../worker/src/api.js')).default;
const env = { TURSO_DATABASE_URL: 'libsql://local.mock', TURSO_AUTH_TOKEN: 'local' };

if (process.argv.includes('--seed')) {
  const raw = await readFile(path.join(ROOT, 'db/seed.sql'), 'utf8');
  const seed = raw.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  for (const stmt of seed.split(';').map((s) => s.trim()).filter(Boolean)) {
    await fetch('https://local.mock/v2/pipeline', {
      method: 'POST',
      body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: stmt, args: [] } }] }),
    });
  }
  console.log('已載入 db/seed.sql 範例資料');
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const apiPath = url.pathname.slice(4) || '/';
    const request = new Request(`https://local.api${apiPath}${url.search}`, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const out = await worker.fetch(request, env);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}).listen(PORT, () => {
  console.log(`VinylVault dev server → http://localhost:${PORT}`);
  console.log(`在 App 的「⚙ 設定」填入： http://localhost:${PORT}/api`);
});
