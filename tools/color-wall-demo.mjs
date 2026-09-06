import { parseColor } from '/home/user/VinylVault/lib/vinyl-color.js';
import { pressingSvg } from '/home/user/VinylVault/lib/vinyl-art.js';
import { writeFileSync } from 'node:fs';
import pw from '/opt/node22/lib/node_modules/playwright/index.js';

const variants = [
  ['Red With Black Splatter', 'UK 2017', '限量 500'],
  ['Orange With Black Splatter', 'JP 2018', '限量 300'],
  ['Clear With Black Splatter', 'EU 2019', '限量 500'],
  ['Blue With Black Splatter', 'US 2019', '獨佔'],
  ['Neon Green With Black Splatter', 'UK 2021', '限量 250'],
  ['Black', 'EU 2017', '常規版'],
];

const cards = variants.map(([txt, where, tag], i) => {
  const spec = parseColor(txt);
  const svg = pressingSvg(spec, { seed: 'demo' + i, coverLabel: 'MUSIC\nFOR FILM', size: 620 });
  return `<figure>
    <div class="art">${svg}</div>
    <figcaption><b>${txt}</b><span>${where} · ${tag}</span></figcaption>
  </figure>`;
}).join('');

writeFileSync('grid.html', `<!DOCTYPE html><meta charset="utf-8">
<style>
  body{margin:0;background:#0C0A07;color:#F4ECDA;font-family:-apple-system,"Noto Sans TC",sans-serif}
  h1{font-family:Georgia,serif;font-weight:600;font-size:26px;margin:28px 0 4px;text-align:center;letter-spacing:.02em}
  p.sub{text-align:center;color:rgba(244,236,218,.5);font-size:13px;margin:0 0 26px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:0 24px 34px;max-width:1180px;margin:0 auto}
  figure{margin:0;border:1px solid rgba(201,162,75,.22);border-radius:14px;overflow:hidden;background:#0C0A07}
  .art{aspect-ratio:1/1}
  .art svg{display:block;width:100%;height:100%}
  figcaption{padding:11px 14px 14px;border-top:1px solid rgba(201,162,75,.14)}
  figcaption b{display:block;font-size:13.5px;font-weight:600}
  figcaption span{display:block;font-size:11.5px;color:rgba(244,236,218,.5);margin-top:2px}
</style>
<h1>Music For Film — 6 個壓片版本</h1>
<p class="sub">全部由顏色文字自動生成 · 角度光線完全一致 · 無版權問題</p>
<div class="grid">${cards}</div>`);

const b = await pw.chromium.launch();
const page = await b.newPage({ viewport: { width: 1180, height: 1500 }, deviceScaleFactor: 1 });
await page.goto('file:///tmp/claude-0/-home-user-VinylVault/4e90aea8-52e7-5c2c-aabb-aa7b1f92d132/scratchpad/grid.html');
await page.waitForTimeout(900);
await page.screenshot({ path: 'grid.png', fullPage: true });
await b.close();
console.log('done');
