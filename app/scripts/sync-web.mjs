/**
 * 把專案根目錄的網頁檔案複製到 app/www，給 Capacitor 打包。
 *   cd app && npm run copy:web
 */
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const APP  = fileURLToPath(new URL('..', import.meta.url));
const ROOT = path.join(APP, '..');
const WWW  = path.join(APP, 'www');

const FILES = ['index.html', 'config.js', 'manifest.webmanifest'];
const DIRS  = ['assets'];

await rm(WWW, { recursive: true, force: true });
await mkdir(WWW, { recursive: true });

for (const f of FILES) await cp(path.join(ROOT, f), path.join(WWW, f));
for (const d of DIRS)  await cp(path.join(ROOT, d), path.join(WWW, d), { recursive: true });

// App 內建網址設定：優先用環境變數 VV_API_BASE，其次沿用根目錄 config.js 的值。
if (process.env.VV_API_BASE) {
  const cfg = await readFile(path.join(WWW, 'config.js'), 'utf8');
  await writeFile(
    path.join(WWW, 'config.js'),
    cfg.replace(/^(\s*)apiBase:\s*'[^']*'/m, `$1apiBase: '${process.env.VV_API_BASE.replace(/'/g, '')}'`)
  );
  console.log('已將 apiBase 設為', process.env.VV_API_BASE);
}

console.log('已複製網頁檔案到 app/www');
