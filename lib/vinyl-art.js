/**
 * 唱片圖像生成 —— 把 parseColor() 的規格畫成 SVG。
 *
 * 為什麼自己畫而不是抓照片：
 *   1. 覆蓋率 100%（冷門壓片沒有人拍照）
 *   2. 每一張的角度、光線、比例完全一致，才能並排比較
 *   3. 沒有版權問題
 *
 * 同一個 seed 永遠畫出同一張圖，所以每次重整看到的都一樣。
 */

/* ── 種子亂數：同一張壓片每次都長一樣 ────────────────────── */
function rng(seed) {
  let h = 2166136261 >>> 0;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return () => {
    h ^= h << 13; h >>>= 0; h ^= h >> 17; h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── 潑漆：大小不一的斑點加幾道拉長的濺痕 ────────────────── */
function splatterShapes(rand, cx, cy, R, count, color, opacity) {
  const out = [];
  for (let i = 0; i < count; i++) {
    // 往外圈偏一點，中心留白給標籤
    const a = rand() * Math.PI * 2;
    const r = R * (0.36 + Math.pow(rand(), 0.55) * 0.62);
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    const size = R * (0.004 + Math.pow(rand(), 3.0) * 0.048);
    if (rand() < 0.18) {
      // 濺出去的細長痕跡 —— 方向要隨機，沿半徑轉會變成風車圖案
      const rot = rand() * 360;
      out.push(`<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="${(size * (1.8 + rand() * 2.6)).toFixed(1)}" ry="${size.toFixed(1)}" transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})" fill="${color}" opacity="${opacity}"/>`);
    } else {
      out.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${size.toFixed(1)}" fill="${color}" opacity="${opacity}"/>`);
    }
  }
  return out.join('');
}

/* ── 一張唱片 ─────────────────────────────────────────── */
function disc(spec, { cx, cy, R, seed, id, labelColor = '#D8D2C4' }) {
  const rand = rng(seed);
  const base = spec.base[0] || '#141210';
  const second = spec.base[1] || spec.accent[0] || '#F2F0EA';
  const accent = spec.accent[0] || '#141210';
  const seeThrough = spec.finish === 'clear' || spec.finish === 'translucent';
  const alpha = spec.finish === 'clear' ? 0.55 : spec.finish === 'translucent' ? 0.78 : 1;

  const clip = `clip-${id}`;
  const defs = [];
  let fill = base;
  let extra = '';

  if (spec.pattern === 'marbled' || spec.pattern === 'smoke' || spec.pattern === 'galaxy') {
    const f = `f-${id}`, g = `g-${id}`;
    const soft = spec.pattern === 'smoke';
    defs.push(
      `<filter id="${f}" x="-20%" y="-20%" width="140%" height="140%">` +
        `<feTurbulence type="fractalNoise" baseFrequency="${soft ? 0.006 : 0.013}" numOctaves="${soft ? 2 : 4}" seed="${Math.floor(rand() * 999)}" result="n"/>` +
        `<feDisplacementMap in="SourceGraphic" in2="n" scale="${soft ? R * 0.55 : R * 0.9}" xChannelSelector="R" yChannelSelector="G"/>` +
        `<feGaussianBlur stdDeviation="${soft ? R * 0.035 : R * 0.012}"/>` +
      `</filter>`,
      `<linearGradient id="${g}" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0%" stop-color="${second}"/><stop offset="55%" stop-color="${base}"/>` +
        `<stop offset="100%" stop-color="${second}"/></linearGradient>`);
    extra += `<g clip-path="url(#${clip})"><circle cx="${cx}" cy="${cy}" r="${R * 1.15}" fill="url(#${g})" filter="url(#${f})" opacity="${soft ? 0.75 : 0.95}"/></g>`;
    fill = base;
  }

  if (spec.pattern === 'split') {
    extra += `<g clip-path="url(#${clip})"><rect x="${cx}" y="${cy - R}" width="${R}" height="${R * 2}" fill="${second}"/></g>`;
  }

  if (spec.pattern === 'stripe') {
    const bars = [];
    for (let i = -4; i <= 4; i++) {
      bars.push(`<rect x="${cx - R}" y="${cy + i * R * 0.22}" width="${R * 2}" height="${R * 0.11}" fill="${second}" opacity="0.85"/>`);
    }
    extra += `<g clip-path="url(#${clip})">${bars.join('')}</g>`;
  }

  if (spec.pattern === 'splatter' || spec.pattern === 'galaxy') {
    const n = spec.pattern === 'galaxy' ? 190 : 130;
    extra += `<g clip-path="url(#${clip})">${splatterShapes(rand, cx, cy, R, n, accent, 0.92)}</g>`;
  }

  if (spec.finish === 'glitter') {
    const bits = [];
    for (let i = 0; i < 260; i++) {
      const a = rand() * Math.PI * 2, r = R * (0.28 + rand() * 0.7);
      bits.push(`<circle cx="${(cx + Math.cos(a) * r).toFixed(1)}" cy="${(cy + Math.sin(a) * r).toFixed(1)}" r="${(R * 0.004 + rand() * R * 0.005).toFixed(2)}" fill="#fff" opacity="${(0.3 + rand() * 0.6).toFixed(2)}"/>`);
    }
    extra += `<g clip-path="url(#${clip})">${bits.join('')}</g>`;
  }

  // 溝槽：一圈圈細環，是黑膠一眼可辨的特徵
  // 溝槽：深淺兩色交錯才看得出立體，只用單色會糊成一片
  const grooves = [];
  for (let r = R * 0.985; r > R * 0.40; r -= R * 0.011) {
    grooves.push(`<circle cx="${cx}" cy="${cy}" r="${r.toFixed(2)}" fill="none" stroke="#000" stroke-opacity="${(0.13 + rand() * 0.10).toFixed(3)}" stroke-width="${(R * 0.0052).toFixed(2)}"/>`);
    grooves.push(`<circle cx="${cx}" cy="${cy}" r="${(r - R * 0.0055).toFixed(2)}" fill="none" stroke="#fff" stroke-opacity="${(0.05 + rand() * 0.05).toFixed(3)}" stroke-width="${(R * 0.0026).toFixed(2)}"/>`);
  }
  // 導入軌與結束軌之間那圈平滑區，實體唱片上很明顯
  grooves.push(`<circle cx="${cx}" cy="${cy}" r="${(R * 0.395).toFixed(2)}" fill="none" stroke="#000" stroke-opacity="0.22" stroke-width="${(R * 0.012).toFixed(2)}"/>`);

  defs.push(`<clipPath id="${clip}"><circle cx="${cx}" cy="${cy}" r="${R}"/></clipPath>`);
  defs.push(
    `<radialGradient id="sheen-${id}" cx="34%" cy="26%" r="78%">` +
      `<stop offset="0%" stop-color="#fff" stop-opacity="0.30"/>` +
      `<stop offset="42%" stop-color="#fff" stop-opacity="0.06"/>` +
      `<stop offset="100%" stop-color="#000" stop-opacity="0.28"/></radialGradient>`);

  return {
    defs: defs.join(''),
    body:
      `<g>` +
        `<ellipse cx="${cx}" cy="${cy + R * 0.055}" rx="${R * 1.01}" ry="${R * 1.01}" fill="#000" opacity="0.28"/>` +
        (seeThrough
          ? `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${fill}" opacity="${alpha * 0.45}"/>` +
            `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#fff" stroke-opacity="0.30" stroke-width="${R * 0.02}"/>`
          : `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${fill}" opacity="${alpha}"/>`) +
        extra +
        `<g clip-path="url(#${clip})">${grooves.join('')}</g>` +
        `<circle cx="${cx}" cy="${cy}" r="${R}" fill="url(#sheen-${id})"/>` +
        `<circle cx="${cx}" cy="${cy}" r="${R * 0.335}" fill="${labelColor}"/>` +
        `<circle cx="${cx}" cy="${cy}" r="${R * 0.335}" fill="none" stroke="#000" stroke-opacity="0.16" stroke-width="${R * 0.006}"/>` +
        `<circle cx="${cx}" cy="${cy}" r="${R * 0.032}" fill="#0C0A07"/>` +
        `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="#000" stroke-opacity="0.35" stroke-width="${R * 0.007}"/>` +
      `</g>`,
  };
}

/**
 * 一張壓片的方形圖：封套立在後面，唱片在前面錯開。
 * 版面刻意固定，不同壓片並排時才比得出差異。
 */
export function pressingSvg(spec, opts = {}) {
  const {
    size = 1000, seed = 'v', theme = 'dark',
    coverHref = null, coverLabel = '', discs = 2, labelColor = '#D8D2C4',
  } = opts;

  const bg = theme === 'dark' ? '#0C0A07' : '#F4F4F2';
  const sleeveFallback = theme === 'dark' ? '#1B1710' : '#DAD7D0';
  const id = String(seed).replace(/[^\w]/g, '').slice(0, 12) || 'x';

  // 版面：封套佔上方偏左，唱片在下方偏右錯開
  const S = size * 0.545;                // 封套邊長
  const sx = size * 0.105, sy = size * 0.085;
  const R = size * 0.196;                // 唱片半徑
  const d1 = { cx: size * 0.415, cy: size * 0.715 };
  const d2 = { cx: size * 0.695, cy: size * 0.735 };

  const parts = [];
  const defs = [];
  const list = discs >= 2 ? [d2, d1] : [d1];   // 後面那張先畫
  list.forEach((pos, i) => {
    const d = disc(spec, { ...pos, R, seed: seed + ':' + i, id: id + i, labelColor });
    defs.push(d.defs); parts.push(d.body);
  });

  const cover = coverHref
    ? `<image href="${esc(coverHref)}" x="${sx}" y="${sy}" width="${S}" height="${S}" preserveAspectRatio="xMidYMid slice"/>`
    : `<rect x="${sx}" y="${sy}" width="${S}" height="${S}" fill="${sleeveFallback}"/>` +
      `<text x="${sx + S / 2}" y="${sy + S / 2}" text-anchor="middle" dominant-baseline="middle"
             font-family="Georgia, serif" font-size="${S * 0.1}" fill="${theme === 'dark' ? '#C9A24B' : '#8A7D5F'}"
             opacity="0.75">${esc(coverLabel)}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<defs>${defs.join('')}` +
      `<linearGradient id="sl-${id}" x1="0" y1="0" x2="1" y2="1">` +
        `<stop offset="0%" stop-color="#fff" stop-opacity="0.12"/>` +
        `<stop offset="60%" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `</defs>` +
    `<rect width="${size}" height="${size}" fill="${bg}"/>` +
    // 封套：立著，右側有一小片厚度，看起來像實體
    `<g>` +
      `<rect x="${sx + S}" y="${sy + S * 0.012}" width="${S * 0.045}" height="${S}" fill="#000" opacity="0.45"/>` +
      cover +
      `<rect x="${sx}" y="${sy}" width="${S}" height="${S}" fill="url(#sl-${id})"/>` +
      `<rect x="${sx}" y="${sy}" width="${S}" height="${S}" fill="none" stroke="#000" stroke-opacity="0.35" stroke-width="${size * 0.002}"/>` +
    `</g>` +
    parts.join('') +
  `</svg>`;
}
