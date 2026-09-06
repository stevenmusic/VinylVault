import test from 'node:test';
import assert from 'node:assert/strict';
import { parseColor } from '../vinyl-color.js';
import { pressingSvg } from '../vinyl-art.js';

test('底色與潑色分得出來', () => {
  const r = parseColor('Red With Black Splatter');
  assert.equal(r.pattern, 'splatter');
  assert.deepEqual(r.base, ['#C0271F']);
  assert.deepEqual(r.accent, ['#141210']);
});

test('透明底＋潑色：顏色是潑上去的，不是底色', () => {
  const r = parseColor('Clear With Black Splatter');
  assert.equal(r.finish, 'clear');
  assert.equal(r.accent[0], '#141210');
  assert.notEqual(r.base[0], '#141210', '透明片的底不該是黑的');
});

test('長名稱優先，不會被短的吃掉', () => {
  assert.equal(parseColor('Sea Blue').base[0], '#2C6F97');
  assert.notEqual(parseColor('Sea Blue').base[0], parseColor('Blue').base[0]);
  assert.equal(parseColor('Neon Green').base[0], '#9BD62B');
});

test('對半與大理石紋', () => {
  assert.equal(parseColor('Half Red Half White').pattern, 'split');
  assert.equal(parseColor('Blue/White Marbled').pattern, 'marbled');
  assert.equal(parseColor('Green Swirl').pattern, 'marbled');
});

test('格式字串裡的雜訊會被濾掉', () => {
  const r = parseColor('2×LP, Album, Ltd, RE, 180 Gram, Gold');
  assert.equal(r.base[0], '#C9A24B');
  assert.equal(r.unknown, false);
});

test('認不出來的顏色要標記，不能默默畫成黑色', () => {
  assert.equal(parseColor('Ultra Chartreuse Fizz').unknown, true);
  assert.equal(parseColor(''), null);
});

test('同一個 seed 產生同一張圖，不同 seed 不同', () => {
  const spec = parseColor('Blue With Black Splatter');
  assert.equal(pressingSvg(spec, { seed: 'a' }), pressingSvg(spec, { seed: 'a' }));
  assert.notEqual(pressingSvg(spec, { seed: 'a' }), pressingSvg(spec, { seed: 'b' }));
});

test('產生的是合法且自足的 SVG', () => {
  const svg = pressingSvg(parseColor('Neon Green With Black Splatter'), { seed: 's', size: 400 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  assert.ok(!/<image/.test(svg), '沒有封面時不該引用外部圖片');
  // 每個 id 都要唯一，同頁面放多張才不會互相汙染
  const ids = [...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('封面網址會被正確跳脫', () => {
  const svg = pressingSvg(parseColor('Black'), { seed: 's', coverHref: 'https://x/y?a=1&b="2"' });
  assert.ok(svg.includes('&amp;'), '& 要跳脫');
  assert.ok(!svg.includes('b="2"'), '引號要跳脫，不然會破壞屬性');
});
