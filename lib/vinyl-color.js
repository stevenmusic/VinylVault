/**
 * 唱片顏色解析 —— 把 Discogs / 廠牌那種自由文字，變成可以畫出來的規格。
 *
 *   parseColor('Translucent Blue With Black Splatter')
 *   → { base:['#2E5FA3'], accent:['#141210'], pattern:'splatter', finish:'translucent' }
 *
 * 這層是整個視覺化的地基：顏色文字寫法非常亂，先正規化才畫得出一致的圖。
 */

/** 常見的黑膠顏色名稱。刻意只放「顏色詞」，圖樣與質感另外判斷。 */
const NAMES = {
  // 黑白灰
  black: '#141210', 'jet black': '#0B0A09', white: '#F2F0EA', bone: '#E8E0CE',
  cream: '#EFE4C8', ivory: '#F3EBD8', grey: '#8C8C8C', gray: '#8C8C8C',
  'smoke': '#A9A29A', charcoal: '#3A3733', silver: '#C4C7CB',

  // 紅粉
  red: '#C0271F', 'blood red': '#8E1B18', 'oxblood': '#6B2029', crimson: '#B01B32',
  ruby: '#A8102B', scarlet: '#D02B1E', maroon: '#5E1A22', burgundy: '#5C1B2B',
  pink: '#E48AAE', 'hot pink': '#E53E86', magenta: '#C2237A', rose: '#D97A8E',
  'bubblegum': '#F09BC0', coral: '#E4715C', salmon: '#E98A76',

  // 橘黃
  orange: '#E07B23', tangerine: '#E86A18', amber: '#D99A2B', rust: '#A85728',
  'burnt orange': '#B85B22', yellow: '#E8C33A', 'canary yellow': '#F0D437',
  gold: '#C9A24B', mustard: '#C69B28', honey: '#D9A441', 'root beer': '#6B3A22',
  'coke bottle': '#4E6B4A', 'coke bottle clear': '#4E6B4A',

  // 綠
  green: '#3F8A4B', 'olive green': '#6E7A34', olive: '#6E7A34', mint: '#8FD3B0',
  'sea foam': '#8ED2BE', seafoam: '#8ED2BE', emerald: '#1E8A62', jade: '#4F7A5C',
  'forest green': '#27512F', lime: '#A8CE3A', 'neon green': '#9BD62B',
  'swamp green': '#5A6B33', 'electric green': '#4FD44F',

  // 藍
  blue: '#2E5FA3', 'sky blue': '#77B4DE', 'baby blue': '#A8CDE6', 'sea blue': '#2C6F97',
  'royal blue': '#2340A0', navy: '#1B2B55', 'navy blue': '#1B2B55', cobalt: '#1E4FBF',
  teal: '#177C8A', turquoise: '#2BB0AE', aqua: '#63C7CD', cyan: '#2FB6D6',
  'ice blue': '#C3DDEA', 'electric blue': '#2C7BE0',

  // 紫棕
  purple: '#6B3E9E', violet: '#7A4BB5', lavender: '#B9A3DC', plum: '#6A3552',
  grape: '#5A2C7E', brown: '#6B4A32', tan: '#B99A6E', beige: '#DCCBA8',
  copper: '#B06B3A', bronze: '#9A6B34',
};

/** 圖樣：唱片上顏色怎麼分佈 */
const PATTERNS = [
  ['splatter',  /splatter|splattered|speckle|spekled|speckled|dot(ted)?/i],
  ['galaxy',    /galaxy|nebula|cosmic|starburst/i],
  ['marbled',   /marble[d]?|swirl(ed)?|mixed|blob|cloudy|cloud/i],
  ['split',     /split|\bhalf\b.*\bhalf\b|two[\s\-]?tone|bi[\s\-]?colou?r/i],
  ['smoke',     /smoke[y]?|haze|hazy|mist|milky/i],
  ['stripe',    /stripe[d]?|striped/i],
  ['picture',   /picture\s?disc/i],
];

const FINISHES = [
  ['clear',       /\bclear\b|transparent|crystal/i],
  ['translucent', /translucent|see[\s\-]?through|opaque\s?tint/i],
  ['glitter',     /glitter|sparkle|metallic|shimmer/i],
  ['glow',        /glow(\s?in\s?the\s?dark)?|luminous/i],
];

const clean = (s) => String(s || '').toLowerCase()
  .replace(/[（）()]/g, ' ')
  .replace(/\b(vinyl|lp|record|colou?red|colour|color|edition|ltd|limited|album|re|reissue|180\s?g(ram)?|\d+["″]?)\b/g, ' ')
  .replace(/[,\/&+]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** 依名稱長度由長到短比對，"sea blue" 才不會先被 "blue" 吃掉 */
const SORTED = Object.keys(NAMES).sort((a, b) => b.length - a.length);

function findColors(text) {
  const found = [];
  let rest = ' ' + text + ' ';
  for (const name of SORTED) {
    const re = new RegExp('(?<=[^a-z])' + name.replace(/ /g, '[\\s\\-]+') + '(?=[^a-z])', 'g');
    if (re.test(rest)) {
      found.push({ name, hex: NAMES[name], at: rest.search(re) });
      rest = rest.replace(re, ' '.repeat(name.length));
    }
  }
  return found.sort((a, b) => a.at - b.at).map((c) => c.hex);
}

export function parseColor(text) {
  const src = clean(text);
  if (!src) return null;

  let pattern = 'solid';
  for (const [name, re] of PATTERNS) if (re.test(src)) { pattern = name; break; }

  let finish = 'opaque';
  for (const [name, re] of FINISHES) if (re.test(src)) { finish = name; break; }

  const colors = findColors(src);

  // 透明底＋潑色：文字裡通常只寫潑上去那個顏色（Clear With Black Splatter），
  // 這時該顏色是 accent，底是透明的，不能拿來當底色。
  const seeThrough = finish === 'clear' || finish === 'translucent';
  const splashy = pattern === 'splatter' || pattern === 'galaxy' || pattern === 'smoke';
  let base, accent;
  if (seeThrough && splashy && colors.length === 1) {
    base = ['#E9E6E0'];
    accent = [colors[0]];
  } else {
    base = colors.length ? [colors[0]] : [seeThrough ? '#E9E6E0' : '#141210'];
    accent = colors.slice(1);
  }

  if (!accent.length && (pattern === 'splatter' || pattern === 'galaxy')) accent = ['#141210'];
  if (!accent.length && (pattern === 'marbled' || pattern === 'split' || pattern === 'stripe')) {
    accent = ['#F2F0EA'];
  }
  if (pattern === 'split' || pattern === 'marbled') base.push(accent[0]);

  // 文字裡有形容詞但一個顏色都沒對上 → 標記出來，讓介面提示可以手動指定，
  // 而不是默默畫成黑色騙人。
  const unknown = colors.length === 0 && pattern === 'solid' && finish === 'opaque';

  return { base, accent, pattern, finish, unknown, source: String(text) };
}

export const COLOR_NAMES = NAMES;
