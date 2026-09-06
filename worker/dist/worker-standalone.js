/**
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

/**
 * VinylVault API — Cloudflare Worker
 *
 * 前端 -> 這個 Worker -> Turso (libSQL HTTP API)
 * Turso 的 URL / Token 只存在 Worker 的環境變數，永遠不會出現在瀏覽器。
 *
 * 需要的環境變數（Worker Settings -> Variables）：
 *   TURSO_DATABASE_URL  例：libsql://vinylvault-db-xxxx.turso.io   (Secret 或一般變數皆可)
 *   TURSO_AUTH_TOKEN    Turso 的 auth token                        (務必存成 Secret)
 * 選用：
 *   ALLOWED_ORIGINS     逗號分隔的允許來源；未設定 = 允許全部 (*)
 *                       例：https://stevenmusic.github.io,capacitor://localhost
 *   WRITE_TOKEN         若設定，所有寫入 (POST/PATCH/DELETE) 需帶
 *                       Authorization: Bearer <WRITE_TOKEN>
 *
 * 路由：
 *   GET    /                前端網頁本身（直接開這個網址就能用）
 *   GET    /health
 *   GET    /mb?path=…            MusicBrainz 代理（避開瀏覽器跨網域限制）
 *   GET    /setup            建立資料表（?seed=1 順便加範例資料）
 *   GET    /artists                 ?q=&limit=&offset=
 *   POST   /artists
 *   GET    /artists/:id
 *   PATCH  /artists/:id
 *   DELETE /artists/:id
 *   GET    /albums                  ?artist_id=&q=
 *   POST   /albums
 *   GET    /albums/:id
 *   PATCH  /albums/:id
 *   DELETE /albums/:id
 *   GET    /versions                ?album_id=&artist_id=&want=1&owned=1&region=
 *   POST   /versions
 *   GET    /versions/:id
 *   PATCH  /versions/:id            （含 want / owned 切換）
 *   DELETE /versions/:id
 *   GET    /versions/:id/tracks     曲目
 *   PUT    /versions/:id/tracks     整批取代曲目
 *   GET    /stats
 */

/* -------------------------------------------------------------------------- */
/* Turso HTTP client（零依賴，直接打 /v2/pipeline）                            */
/* -------------------------------------------------------------------------- */

function tursoEndpoint(rawUrl) {
  if (!rawUrl) throw new HttpError(500, 'TURSO_DATABASE_URL is not configured');
  const url = rawUrl.trim().replace(/^libsql:\/\//, 'https://').replace(/\/+$/, '');
  return `${url}/v2/pipeline`;
}

function toTursoValue(v) {
  if (v === null || v === undefined) return { type: 'null' };
  if (typeof v === 'boolean') return { type: 'integer', value: v ? '1' : '0' };
  if (typeof v === 'number') {
    return Number.isInteger(v)
      ? { type: 'integer', value: String(v) }
      : { type: 'float', value: v };
  }
  if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
  return { type: 'text', value: String(v) };
}

function fromTursoValue(cell) {
  if (!cell || cell.type === 'null') return null;
  switch (cell.type) {
    case 'integer': return Number(cell.value);
    case 'float':   return typeof cell.value === 'number' ? cell.value : Number(cell.value);
    case 'text':    return cell.value;
    case 'blob':    return cell.base64 ?? cell.value ?? null;
    default:        return cell.value ?? null;
  }
}

/** 執行一段 SQL，回傳 { rows, rowsAffected, lastInsertRowid } */
async function query(env, sql, args = []) {
  const body = {
    requests: [
      { type: 'execute', stmt: { sql, args: args.map(toTursoValue) } },
      { type: 'close' },
    ],
  };

  const res = await fetch(tursoEndpoint(env.TURSO_DATABASE_URL), {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.TURSO_AUTH_TOKEN ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(502, `Turso HTTP ${res.status}: ${text.slice(0, 400)}`);
  }

  const json = await res.json();
  const first = json.results?.[0];
  if (!first) throw new HttpError(502, 'Turso returned no result');
  if (first.type === 'error') {
    throw new HttpError(400, first.error?.message ?? 'Turso query error');
  }

  const result = first.response?.result ?? {};
  const cols = (result.cols ?? []).map((c) => c.name);
  const rows = (result.rows ?? []).map((row) => {
    const obj = {};
    row.forEach((cell, i) => { obj[cols[i]] = fromTursoValue(cell); });
    return obj;
  });

  return {
    rows,
    rowsAffected: Number(result.affected_row_count ?? 0),
    lastInsertRowid: result.last_insert_rowid != null ? Number(result.last_insert_rowid) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const allowOrigin = allowed.length === 0
    ? '*'
    : (allowed.includes(origin) ? origin : allowed[0]);

  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(data, { status = 200, request, env } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(request ? corsHeaders(request, env) : {}),
    },
  });
}

function requireWriteAuth(request, env) {
  if (!env.WRITE_TOKEN) return;
  const header = request.headers.get('Authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (token !== env.WRITE_TOKEN) throw new HttpError(401, 'Unauthorized');
}

async function readJson(request) {
  try {
    const data = await request.json();
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('body must be a JSON object');
    }
    return data;
  } catch (e) {
    throw new HttpError(400, `Invalid JSON body: ${e.message}`);
  }
}

const toBit = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
const toIntOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const toNumOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** 從唱片編號取出面別：A1 -> A、B2 -> B */
const sideOf = (number) => {
  const m = /^\s*([A-Za-z])/.exec(number ?? '');
  return m ? m[1].toUpperCase() : null;
};

const toStrOrNull = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** 只挑白名單欄位，組成 UPDATE 的 SET 片段（防 SQL injection：欄位名寫死） */
function buildUpdate(table, id, body, fields) {
  const sets = [];
  const args = [];
  for (const [col, cast] of Object.entries(fields)) {
    if (!Object.prototype.hasOwnProperty.call(body, col)) continue;
    sets.push(`${col} = ?`);
    args.push(cast(body[col]));
  }
  if (sets.length === 0) throw new HttpError(400, 'No updatable fields provided');
  args.push(id);
  return { sql: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, args };
}

/* -------------------------------------------------------------------------- */
/* 欄位定義                                                                    */
/* -------------------------------------------------------------------------- */

const ARTIST_FIELDS = {
  name: toStrOrNull, sort_name: toStrOrNull, country: toStrOrNull,
  image_url: toStrOrNull, notes: toStrOrNull, mb_id: toStrOrNull,
};

const ALBUM_FIELDS = {
  artist_id: toIntOrNull, title: toStrOrNull, release_year: toIntOrNull,
  cover_url: toStrOrNull, label: toStrOrNull, notes: toStrOrNull, mb_id: toStrOrNull,
};

const VERSION_FIELDS = {
  album_id: toIntOrNull, name: toStrOrNull, cover_url: toStrOrNull,
  color: toStrOrNull, color_hex: toStrOrNull,
  is_limited: toBit, is_exclusive: toBit, exclusive_to: toStrOrNull,
  region: toStrOrNull, release_date: toStrOrNull, edition_size: toIntOrNull,
  price: toNumOrNull, currency: toStrOrNull, buy_url: toStrOrNull,
  want: toBit, owned: toBit, notes: toStrOrNull,
  format: toStrOrNull, catalog_no: toStrOrNull, mb_id: toStrOrNull, tracks_loaded: toBit,
};

/* -------------------------------------------------------------------------- */
/* 建表（GET/POST /setup）—— 不必碰 Turso 的 SQL Console                        */
/* -------------------------------------------------------------------------- */

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS artists (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     name        TEXT    NOT NULL,
     sort_name   TEXT,
     country     TEXT,
     image_url   TEXT,
     notes       TEXT,
     mb_id       TEXT,
     created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
     updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS albums (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     artist_id    INTEGER NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
     title        TEXT    NOT NULL,
     release_year INTEGER,
     cover_url    TEXT,
     label        TEXT,
     notes        TEXT,
     mb_id        TEXT,
     created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
     updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS versions (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     album_id      INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
     name          TEXT    NOT NULL,
     cover_url     TEXT,
     color         TEXT,
     color_hex     TEXT,
     is_limited    INTEGER NOT NULL DEFAULT 0 CHECK (is_limited IN (0,1)),
     is_exclusive  INTEGER NOT NULL DEFAULT 0 CHECK (is_exclusive IN (0,1)),
     exclusive_to  TEXT,
     region        TEXT,
     release_date  TEXT,
     edition_size  INTEGER,
     price         REAL,
     currency      TEXT    DEFAULT 'USD',
     buy_url       TEXT,
     want          INTEGER NOT NULL DEFAULT 0 CHECK (want IN (0,1)),
     owned         INTEGER NOT NULL DEFAULT 0 CHECK (owned IN (0,1)),
     notes         TEXT,
     format        TEXT,
     catalog_no    TEXT,
     mb_id         TEXT,
     tracks_loaded INTEGER NOT NULL DEFAULT 0 CHECK (tracks_loaded IN (0,1)),
     created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
     updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS tracks (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     version_id  INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
     position    INTEGER NOT NULL,
     side        TEXT,
     number      TEXT,
     title       TEXT    NOT NULL,
     length_ms   INTEGER,
     created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_name   ON artists(name)`,
  `CREATE INDEX IF NOT EXISTS idx_albums_artist         ON albums(artist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_versions_album        ON versions(album_id)`,
  `CREATE INDEX IF NOT EXISTS idx_versions_want         ON versions(want)`,
  `CREATE INDEX IF NOT EXISTS idx_versions_owned        ON versions(owned)`,
  `CREATE INDEX IF NOT EXISTS idx_versions_region       ON versions(region)`,
  `CREATE INDEX IF NOT EXISTS idx_versions_mb           ON versions(mb_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tracks_version        ON tracks(version_id, position)`,
];

/** 舊資料庫升級用：欄位已存在時 SQLite 會報錯，直接忽略。 */
const SCHEMA_MIGRATIONS = [
  `ALTER TABLE artists  ADD COLUMN mb_id TEXT`,
  `ALTER TABLE albums   ADD COLUMN mb_id TEXT`,
  `ALTER TABLE versions ADD COLUMN format TEXT`,
  `ALTER TABLE versions ADD COLUMN catalog_no TEXT`,
  `ALTER TABLE versions ADD COLUMN mb_id TEXT`,
  `ALTER TABLE versions ADD COLUMN tracks_loaded INTEGER NOT NULL DEFAULT 0`,
];

async function runSetup(env, { seed = false } = {}) {
  for (const sql of SCHEMA_STATEMENTS) await query(env, sql);
  for (const sql of SCHEMA_MIGRATIONS) {
    try { await query(env, sql); } catch { /* 欄位已存在 */ }
  }

  const { rows } = await query(env,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  const tables = rows.map((r) => r.name);

  let seeded = false;
  if (seed) {
    const { rows: c } = await query(env, 'SELECT COUNT(*) AS n FROM artists');
    if (c[0].n === 0) {
      const artist = await query(env,
        `INSERT INTO artists (name, country, notes) VALUES (?, ?, ?)`,
        ['Taylor Swift', 'US', '範例資料，可以直接刪掉']);
      const album = await query(env,
        `INSERT INTO albums (artist_id, title, release_year, label) VALUES (?, ?, ?, ?)`,
        [artist.lastInsertRowid, 'Midnights', 2022, 'Republic']);
      await query(env,
        `INSERT INTO versions (album_id, name, color, color_hex, is_limited, is_exclusive,
                               exclusive_to, region, release_date, edition_size, price, currency, want)
         VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?, 1)`,
        [album.lastInsertRowid, 'Jade Green Edition', 'Jade Green', '#4F7A5C',
         'Official Store', 'US', '2022-10-21', 5000, 34.99, 'USD']);
      await query(env,
        `INSERT INTO versions (album_id, name, color, color_hex, is_limited, region,
                               release_date, price, currency, owned)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 1)`,
        [album.lastInsertRowid, 'Blood Moon Edition', 'Marbled Red', '#8E2F2F',
         'UK', '2022-10-21', 32.0, 'GBP']);
      seeded = true;
    }
  }

  return {
    ok: true,
    message: seeded
      ? '資料表已建立，並加入了範例資料。回到 App 重新整理就看得到了。'
      : '資料表已建立完成，可以開始使用了。',
    tables,
    seeded,
  };
}

/* -------------------------------------------------------------------------- */
/* 路由處理                                                                    */
/* -------------------------------------------------------------------------- */

async function handle(request, env, assets) {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const segments = url.pathname.split('/').filter(Boolean);
  const [resource, rawId, sub] = segments;
  const id = rawId != null ? toIntOrNull(rawId) : null;
  const p = url.searchParams;

  if (segments.length > 3 || (segments.length === 3 && sub !== 'tracks')) {
    throw new HttpError(404, 'Not found');
  }
  if (rawId != null && id === null) throw new HttpError(400, 'Invalid id');
  if (method !== 'GET' && method !== 'OPTIONS') requireWriteAuth(request, env);

  /* ---- 前端網頁（直接開 Worker 網址就能用 App） ---- */
  if (assets && method === 'GET') {
    if (!resource || resource === 'index.html') return { raw: assets.html, type: 'text/html; charset=utf-8' };
    if (resource === 'config.js') {
      // Worker 同時提供網頁與 API，所以前端直接打自己的網址（同源，不會有 CORS 問題）
      return {
        raw: `window.VINYLVAULT_CONFIG = { apiBase: ${JSON.stringify(url.origin)}, writeToken: '' };`,
        type: 'text/javascript; charset=utf-8',
      };
    }
    if (resource === 'manifest.webmanifest') return { raw: assets.manifest, type: 'application/manifest+json; charset=utf-8' };
  }

  /* ---- health ---- */
  if (!resource || resource === 'health') {
    const configured = Boolean(env.TURSO_DATABASE_URL && env.TURSO_AUTH_TOKEN);
    let db = 'unknown';
    if (configured) {
      try { await query(env, 'SELECT 1'); db = 'ok'; }
      catch (e) { db = `error: ${e.message}`; }
    }
    return { service: 'vinylvault-api', ok: db === 'ok', configured, db };
  }

  /* ---- setup：建立資料表（可用手機瀏覽器直接開） ---- */
  if (resource === 'setup') {
    if (method !== 'GET' && method !== 'POST') throw new HttpError(404, 'Not found');
    // GET 也要驗證：手機用網址列時可用 ?token=<WRITE_TOKEN>
    if (env.WRITE_TOKEN) {
      const header = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
      if (header !== env.WRITE_TOKEN && p.get('token') !== env.WRITE_TOKEN) {
        throw new HttpError(401, 'Unauthorized');
      }
    }
    return runSetup(env, { seed: p.get('seed') === '1' || p.get('seed') === 'true' });
  }

  /* ---- MusicBrainz 代理：讓前端不受瀏覽器跨網域限制 ---- */
  if (resource === 'mb' && method === 'GET') {
    const target = p.get('path') ?? '';
    // 只放行 MusicBrainz 的查詢路徑，避免變成任意網址的跳板
    if (!/^\/(artist|release|release-group|recording)(\/[A-Za-z0-9-]+)?(\?[^#]*)?$/.test(target)) {
      throw new HttpError(400, 'Unsupported MusicBrainz path');
    }
    const upstream = 'https://musicbrainz.org/ws/2' + target +
      (target.includes('?') ? '&' : '?') + 'fmt=json';
    let res;
    try {
      res = await fetch(upstream, {
        headers: {
          // MusicBrainz 要求帶上可辨識的 User-Agent
          'User-Agent': 'VinylVault/1.0 (https://github.com/stevenmusic/VinylVault)',
          'Accept': 'application/json',
        },
      });
    } catch (e) {
      // 上游連不上是對方的問題，不是這個 Worker 壞了 —— 回 502 前端才分得出來
      throw new HttpError(502, 'MusicBrainz unreachable: ' + (e.message || 'network error'));
    }
    const body = await res.text();
    return { raw: body, type: 'application/json; charset=utf-8', status: res.status, cors: true };
  }

  /* ---- stats ---- */
  if (resource === 'stats' && method === 'GET') {
    const { rows } = await query(env, `
      SELECT
        (SELECT COUNT(*) FROM artists)                   AS artists,
        (SELECT COUNT(*) FROM albums)                    AS albums,
        (SELECT COUNT(*) FROM versions)                  AS versions,
        (SELECT COUNT(*) FROM versions WHERE want = 1)   AS want,
        (SELECT COUNT(*) FROM versions WHERE owned = 1)  AS owned
    `);
    return rows[0];
  }

  /* ---- artists ---- */
  if (resource === 'artists') {
    if (method === 'GET' && id === null) {
      const q = toStrOrNull(p.get('q'));
      const limit = Math.min(toIntOrNull(p.get('limit')) ?? 500, 1000);
      const offset = toIntOrNull(p.get('offset')) ?? 0;
      const args = [];
      let where = '';
      if (q) { where = 'WHERE a.name LIKE ?'; args.push(`%${q}%`); }
      args.push(limit, offset);
      const { rows } = await query(env, `
        SELECT a.*,
          (SELECT COUNT(*) FROM albums   al WHERE al.artist_id = a.id) AS album_count,
          (SELECT COUNT(*) FROM versions v
             JOIN albums al2 ON al2.id = v.album_id
            WHERE al2.artist_id = a.id)                                AS version_count,
          (SELECT COUNT(*) FROM versions v
             JOIN albums al3 ON al3.id = v.album_id
            WHERE al3.artist_id = a.id AND v.owned = 1)                AS owned_count
        FROM artists a
        ${where}
        ORDER BY COALESCE(NULLIF(a.sort_name, ''), a.name) COLLATE NOCASE
        LIMIT ? OFFSET ?
      `, args);
      return rows;
    }

    if (method === 'GET' && id !== null) {
      const { rows } = await query(env, 'SELECT * FROM artists WHERE id = ?', [id]);
      if (!rows[0]) throw new HttpError(404, 'Artist not found');
      return rows[0];
    }

    if (method === 'POST') {
      const body = await readJson(request);
      const name = toStrOrNull(body.name);
      if (!name) throw new HttpError(400, 'name is required');
      const { lastInsertRowid } = await query(env,
        `INSERT INTO artists (name, sort_name, country, image_url, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [name, toStrOrNull(body.sort_name), toStrOrNull(body.country),
         toStrOrNull(body.image_url), toStrOrNull(body.notes)]);
      const { rows } = await query(env, 'SELECT * FROM artists WHERE id = ?', [lastInsertRowid]);
      return { status: 201, data: rows[0] };
    }

    if (method === 'PATCH' && id !== null) {
      const body = await readJson(request);
      const { sql, args } = buildUpdate('artists', id, body, ARTIST_FIELDS);
      const { rowsAffected } = await query(env, sql, args);
      if (rowsAffected === 0) throw new HttpError(404, 'Artist not found');
      const { rows } = await query(env, 'SELECT * FROM artists WHERE id = ?', [id]);
      return rows[0];
    }

    if (method === 'DELETE' && id !== null) {
      const { rowsAffected } = await query(env, 'DELETE FROM artists WHERE id = ?', [id]);
      if (rowsAffected === 0) throw new HttpError(404, 'Artist not found');
      return { deleted: true, id };
    }
  }

  /* ---- albums ---- */
  if (resource === 'albums') {
    if (method === 'GET' && id === null) {
      const artistId = toIntOrNull(p.get('artist_id'));
      const q = toStrOrNull(p.get('q'));
      const clauses = [];
      const args = [];
      if (artistId !== null) { clauses.push('al.artist_id = ?'); args.push(artistId); }
      if (q) { clauses.push('al.title LIKE ?'); args.push(`%${q}%`); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const { rows } = await query(env, `
        SELECT al.*, ar.name AS artist_name,
          (SELECT COUNT(*) FROM versions v WHERE v.album_id = al.id)                 AS version_count,
          (SELECT COUNT(*) FROM versions v WHERE v.album_id = al.id AND v.owned = 1) AS owned_count,
          (SELECT COUNT(*) FROM versions v WHERE v.album_id = al.id AND v.want = 1)  AS want_count
        FROM albums al
        JOIN artists ar ON ar.id = al.artist_id
        ${where}
        ORDER BY COALESCE(al.release_year, 9999) DESC, al.title COLLATE NOCASE
      `, args);
      return rows;
    }

    if (method === 'GET' && id !== null) {
      const { rows } = await query(env,
        `SELECT al.*, ar.name AS artist_name
           FROM albums al JOIN artists ar ON ar.id = al.artist_id
          WHERE al.id = ?`, [id]);
      if (!rows[0]) throw new HttpError(404, 'Album not found');
      return rows[0];
    }

    if (method === 'POST') {
      const body = await readJson(request);
      const artistId = toIntOrNull(body.artist_id);
      const title = toStrOrNull(body.title);
      if (artistId === null) throw new HttpError(400, 'artist_id is required');
      if (!title) throw new HttpError(400, 'title is required');
      const { lastInsertRowid } = await query(env,
        `INSERT INTO albums (artist_id, title, release_year, cover_url, label, notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [artistId, title, toIntOrNull(body.release_year), toStrOrNull(body.cover_url),
         toStrOrNull(body.label), toStrOrNull(body.notes)]);
      const { rows } = await query(env, 'SELECT * FROM albums WHERE id = ?', [lastInsertRowid]);
      return { status: 201, data: rows[0] };
    }

    if (method === 'PATCH' && id !== null) {
      const body = await readJson(request);
      const { sql, args } = buildUpdate('albums', id, body, ALBUM_FIELDS);
      const { rowsAffected } = await query(env, sql, args);
      if (rowsAffected === 0) throw new HttpError(404, 'Album not found');
      const { rows } = await query(env, 'SELECT * FROM albums WHERE id = ?', [id]);
      return rows[0];
    }

    if (method === 'DELETE' && id !== null) {
      const { rowsAffected } = await query(env, 'DELETE FROM albums WHERE id = ?', [id]);
      if (rowsAffected === 0) throw new HttpError(404, 'Album not found');
      return { deleted: true, id };
    }
  }

  /* ---- versions ---- */
  if (resource === 'versions') {
    if (method === 'GET' && id === null) {
      const clauses = [];
      const args = [];
      const albumId = toIntOrNull(p.get('album_id'));
      const artistId = toIntOrNull(p.get('artist_id'));
      const region = toStrOrNull(p.get('region'));
      if (albumId !== null)  { clauses.push('v.album_id = ?');   args.push(albumId); }
      if (artistId !== null) { clauses.push('al.artist_id = ?'); args.push(artistId); }
      if (region)            { clauses.push('v.region = ?');     args.push(region); }
      if (p.get('want') !== null)         clauses.push(`v.want = ${toBit(p.get('want'))}`);
      if (p.get('owned') !== null)        clauses.push(`v.owned = ${toBit(p.get('owned'))}`);
      if (p.get('is_limited') !== null)   clauses.push(`v.is_limited = ${toBit(p.get('is_limited'))}`);
      if (p.get('is_exclusive') !== null) clauses.push(`v.is_exclusive = ${toBit(p.get('is_exclusive'))}`);
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const { rows } = await query(env, `
        SELECT v.*, al.title AS album_title, al.cover_url AS album_cover_url,
               ar.id AS artist_id, ar.name AS artist_name
          FROM versions v
          JOIN albums  al ON al.id = v.album_id
          JOIN artists ar ON ar.id = al.artist_id
        ${where}
        ORDER BY COALESCE(v.release_date, '9999-99-99') DESC, v.name COLLATE NOCASE
      `, args);
      return rows;
    }

    if (method === 'GET' && id !== null && sub === 'tracks') {
      const { rows } = await query(env,
        `SELECT * FROM tracks WHERE version_id = ? ORDER BY position`, [id]);
      return rows;
    }

    // 整批取代某個版本的曲目（匯入曲目時用）
    if (method === 'PUT' && id !== null && sub === 'tracks') {
      const body = await readJson(request);
      const list = Array.isArray(body.tracks) ? body.tracks : null;
      if (!list) throw new HttpError(400, 'tracks must be an array');
      if (list.length > 200) throw new HttpError(400, 'too many tracks');

      const { rows: exists } = await query(env, 'SELECT id FROM versions WHERE id = ?', [id]);
      if (!exists[0]) throw new HttpError(404, 'Version not found');

      await query(env, 'DELETE FROM tracks WHERE version_id = ?', [id]);
      let pos = 0;
      for (const t of list) {
        const title = toStrOrNull(t.title);
        if (!title) continue;
        const number = toStrOrNull(t.number);
        await query(env,
          `INSERT INTO tracks (version_id, position, side, number, title, length_ms)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [id, ++pos, toStrOrNull(t.side) ?? sideOf(number), number, title, toIntOrNull(t.length_ms)]);
      }
      await query(env, 'UPDATE versions SET tracks_loaded = 1 WHERE id = ?', [id]);
      const { rows } = await query(env,
        `SELECT * FROM tracks WHERE version_id = ? ORDER BY position`, [id]);
      return rows;
    }

    if (method === 'GET' && id !== null) {
      const { rows } = await query(env, `
        SELECT v.*, al.title AS album_title, ar.name AS artist_name
          FROM versions v
          JOIN albums  al ON al.id = v.album_id
          JOIN artists ar ON ar.id = al.artist_id
         WHERE v.id = ?`, [id]);
      if (!rows[0]) throw new HttpError(404, 'Version not found');
      return rows[0];
    }

    if (method === 'POST') {
      const body = await readJson(request);
      const albumId = toIntOrNull(body.album_id);
      const name = toStrOrNull(body.name);
      if (albumId === null) throw new HttpError(400, 'album_id is required');
      if (!name) throw new HttpError(400, 'name is required');
      const { lastInsertRowid } = await query(env, `
        INSERT INTO versions
          (album_id, name, cover_url, color, color_hex, is_limited, is_exclusive,
           exclusive_to, region, release_date, edition_size, price, currency,
           buy_url, want, owned, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [albumId, name, toStrOrNull(body.cover_url), toStrOrNull(body.color),
         toStrOrNull(body.color_hex), toBit(body.is_limited), toBit(body.is_exclusive),
         toStrOrNull(body.exclusive_to), toStrOrNull(body.region),
         toStrOrNull(body.release_date), toIntOrNull(body.edition_size),
         toNumOrNull(body.price), toStrOrNull(body.currency) ?? 'USD',
         toStrOrNull(body.buy_url), toBit(body.want), toBit(body.owned),
         toStrOrNull(body.notes)]);
      const { rows } = await query(env, 'SELECT * FROM versions WHERE id = ?', [lastInsertRowid]);
      return { status: 201, data: rows[0] };
    }

    if (method === 'PATCH' && id !== null) {
      const body = await readJson(request);
      const { sql, args } = buildUpdate('versions', id, body, VERSION_FIELDS);
      const { rowsAffected } = await query(env, sql, args);
      if (rowsAffected === 0) throw new HttpError(404, 'Version not found');
      const { rows } = await query(env, 'SELECT * FROM versions WHERE id = ?', [id]);
      return rows[0];
    }

    if (method === 'DELETE' && id !== null) {
      const { rowsAffected } = await query(env, 'DELETE FROM versions WHERE id = ?', [id]);
      if (rowsAffected === 0) throw new HttpError(404, 'Version not found');
      return { deleted: true, id };
    }
  }

  throw new HttpError(404, `No route for ${method} /${segments.join('/')}`);
}

/* -------------------------------------------------------------------------- */

export function createWorker(assets = null) {
  return { async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }
    try {
      // 先複製一份，之後若因為缺資料表要重試，body 才還讀得到
      const retry = request.clone();
      let result;
      try {
        result = await handle(request, env, assets);
      } catch (err) {
        // 資料表還沒建立 → 自動建好再重試一次，使用者不用手動開 /setup
        if (err instanceof HttpError && /no such table/i.test(err.message)) {
          await runSetup(env);
          result = await handle(retry, env, assets);
        } else {
          throw err;
        }
      }
      if (result && typeof result === 'object' && 'raw' in result) {
        return new Response(result.raw, {
          status: result.status ?? 200,
          headers: {
            'Content-Type': result.type,
            'Cache-Control': 'no-cache',
            ...(result.cors ? corsHeaders(request, env) : {}),
          },
        });
      }
      if (result && typeof result === 'object' && 'status' in result && 'data' in result) {
        return json(result.data, { status: result.status, request, env });
      }
      return json(result, { request, env });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(err);
      return json({ error: err.message ?? 'Internal error' }, { status, request, env });
    }
  } };
}


const html = "<!DOCTYPE html>\n<html lang=\"zh-Hant\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">\n<meta name=\"theme-color\" content=\"#0C0A07\">\n<meta name=\"description\" content=\"VinylVault — 黑膠唱片版本收藏管理\">\n<title>VinylVault</title>\n<link rel=\"icon\" href=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%230C0A07'/%3E%3Ccircle cx='16' cy='16' r='10' fill='none' stroke='%23C9A24B' stroke-width='1'/%3E%3Ccircle cx='16' cy='16' r='4' fill='%23C9A24B'/%3E%3C/svg%3E\">\n<link rel=\"manifest\" href=\"manifest.webmanifest\">\n<style>\n:root{\n  --ink:#0C0A07;\n  --ink-2:#131009;\n  --ink-3:#1B1710;\n  --cream:#F4ECDA;\n  --gold:#C9A24B;\n  --gold-dim:#8A6E33;\n  --line:rgba(201,162,75,.22);\n  --muted:rgba(244,236,218,.58);\n  --danger:#C1573F;\n  --ok:#6F9A63;\n  --radius:14px;\n  --shadow:0 18px 44px rgba(0,0,0,.55);\n  --serif:\"Cormorant Garamond\",\"Noto Serif TC\",Georgia,\"Times New Roman\",serif;\n  --sans:-apple-system,BlinkMacSystemFont,\"Segoe UI\",\"Noto Sans TC\",\"PingFang TC\",\"Helvetica Neue\",Arial,sans-serif;\n}\n*{box-sizing:border-box}\nhtml,body{margin:0;padding:0}\nbody{\n  background:var(--ink);\n  color:var(--cream);\n  font-family:var(--sans);\n  font-size:15px;\n  line-height:1.55;\n  -webkit-font-smoothing:antialiased;\n  padding-bottom:env(safe-area-inset-bottom);\n  min-height:100vh;\n}\nbody::before{\n  content:\"\";position:fixed;inset:0;pointer-events:none;z-index:0;\n  background:\n    radial-gradient(900px 500px at 12% -8%, rgba(201,162,75,.13), transparent 62%),\n    radial-gradient(700px 420px at 100% 4%, rgba(201,162,75,.07), transparent 60%);\n}\na{color:var(--gold);text-decoration:none}\nbutton{font:inherit;color:inherit;cursor:pointer}\nimg{max-width:100%;display:block}\n\n/* ---------- layout ---------- */\n.wrap{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:0 18px 96px}\n\nheader.top{\n  position:sticky;top:0;z-index:30;\n  background:rgba(12,10,7,.86);\n  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);\n  border-bottom:1px solid var(--line);\n  padding-top:env(safe-area-inset-top);\n}\n.top-inner{max-width:1180px;margin:0 auto;padding:12px 18px;display:flex;align-items:center;gap:14px}\n.brand{display:flex;align-items:center;gap:10px;cursor:pointer;background:none;border:0;padding:0}\n.brand .disc{\n  width:30px;height:30px;border-radius:50%;flex:none;\n  background:radial-gradient(circle at 50% 50%, var(--gold) 0 15%, var(--ink-3) 16% 100%);\n  box-shadow:0 0 0 1px var(--line), inset 0 0 0 4px rgba(201,162,75,.16);\n}\n.brand h1{\n  font-family:var(--serif);font-size:22px;letter-spacing:.16em;margin:0;font-weight:600;\n  text-transform:uppercase;white-space:nowrap;\n}\n.brand h1 span{color:var(--gold)}\n.top-spacer{flex:1}\n.stat-pill{\n  display:none;gap:14px;font-size:12px;letter-spacing:.08em;color:var(--muted);\n  border:1px solid var(--line);border-radius:999px;padding:6px 14px;white-space:nowrap;\n}\n.stat-pill b{color:var(--gold);font-weight:600}\n@media(min-width:760px){.stat-pill{display:flex}}\n.icon-btn{\n  width:38px;height:38px;flex:none;border-radius:50%;border:1px solid var(--line);\n  background:transparent;display:grid;place-items:center;font-size:16px;color:var(--cream);\n  transition:.16s;\n}\n.icon-btn:hover{border-color:var(--gold);color:var(--gold)}\n\n.crumbs{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12.5px;\n  letter-spacing:.08em;text-transform:uppercase;color:var(--muted);padding:22px 0 6px}\n.crumbs button{background:none;border:0;padding:0;color:var(--muted);letter-spacing:inherit}\n.crumbs button:hover{color:var(--gold)}\n.crumbs .sep{color:var(--gold-dim)}\n.crumbs .cur{color:var(--cream)}\n\n.page-head{display:flex;flex-wrap:wrap;align-items:flex-end;gap:16px;margin:6px 0 22px}\n.page-head .titles{flex:1;min-width:220px}\n.eyebrow{font-size:11.5px;letter-spacing:.28em;text-transform:uppercase;color:var(--gold);margin:0 0 6px}\nh2.title{font-family:var(--serif);font-size:clamp(30px,6vw,46px);line-height:1.06;margin:0;font-weight:600}\n.sub{color:var(--muted);font-size:13.5px;margin-top:8px}\n.rule{height:1px;background:linear-gradient(90deg,var(--gold),transparent);margin:0 0 22px;opacity:.55}\n\n/* ---------- buttons ---------- */\n.btn{\n  border:1px solid var(--line);background:transparent;color:var(--cream);\n  border-radius:999px;padding:9px 18px;font-size:13.5px;letter-spacing:.04em;transition:.16s;\n  display:inline-flex;align-items:center;gap:7px;white-space:nowrap;\n}\n.btn:hover{border-color:var(--gold);color:var(--gold)}\n.btn.primary{background:var(--gold);border-color:var(--gold);color:#171208;font-weight:600}\n.btn.primary:hover{background:#d8b25e;color:#171208}\n.btn.ghost{border-color:transparent;color:var(--muted)}\n.btn.ghost:hover{color:var(--gold)}\n.btn.danger:hover{border-color:var(--danger);color:var(--danger)}\n.btn.sm{padding:6px 13px;font-size:12.5px}\n\n/* ---------- toolbar ---------- */\n.toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:22px}\n.search{position:relative;flex:1;min-width:190px}\n.search input{width:100%;padding:10px 14px 10px 36px}\n.search::before{content:\"⌕\";position:absolute;left:13px;top:50%;transform:translateY(-50%);color:var(--gold);font-size:17px}\n.chips{display:flex;gap:8px;flex-wrap:wrap}\n.chip{\n  border:1px solid var(--line);background:transparent;color:var(--muted);\n  border-radius:999px;padding:7px 15px;font-size:12.5px;letter-spacing:.05em;transition:.16s;\n}\n.chip:hover{color:var(--gold);border-color:var(--gold)}\n.chip.on{background:rgba(201,162,75,.14);border-color:var(--gold);color:var(--gold)}\n\ninput,select,textarea{\n  background:var(--ink-2);border:1px solid var(--line);color:var(--cream);\n  border-radius:10px;padding:10px 13px;font:inherit;font-size:14px;width:100%;\n  transition:.16s;appearance:none;\n}\ninput:focus,select,textarea:focus{outline:none}\ninput:focus,select:focus,textarea:focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(201,162,75,.12)}\nselect{background-image:linear-gradient(45deg,transparent 50%,var(--gold) 50%),linear-gradient(135deg,var(--gold) 50%,transparent 50%);\n  background-position:calc(100% - 17px) 50%,calc(100% - 12px) 50%;background-size:5px 5px,5px 5px;background-repeat:no-repeat;padding-right:34px}\ntextarea{min-height:76px;resize:vertical}\nlabel.fld{display:block;margin-bottom:14px}\nlabel.fld > span{display:block;font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:6px}\n\n/* ---------- grids ---------- */\n.grid{display:grid;gap:16px}\n.grid.artists{grid-template-columns:repeat(auto-fill,minmax(210px,1fr))}\n.grid.albums{grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}\n.grid.versions{grid-template-columns:repeat(auto-fill,minmax(255px,1fr))}\n\n.card{\n  position:relative;background:linear-gradient(180deg,var(--ink-2),var(--ink));\n  border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;\n  transition:.2s;display:flex;flex-direction:column;text-align:left;width:100%;padding:0;\n}\n.card:hover{border-color:var(--gold);transform:translateY(-2px);box-shadow:var(--shadow)}\n.card .body{padding:14px 15px 15px;display:flex;flex-direction:column;gap:6px;flex:1}\n.card h3{font-family:var(--serif);font-size:19px;margin:0;font-weight:600;line-height:1.2}\n.card .meta{font-size:12.5px;color:var(--muted)}\n\n.cover{position:relative;aspect-ratio:1/1;background:var(--ink-3);overflow:hidden}\n.cover img{width:100%;height:100%;object-fit:cover}\n.cover.ph{display:grid;place-items:center;\n  background:radial-gradient(circle at 50% 50%, rgba(201,162,75,.16) 0 18%, var(--ink-3) 19% 100%)}\n.cover.ph::after{content:\"\";width:16%;aspect-ratio:1;border-radius:50%;background:var(--gold);opacity:.55}\n\n.artist-card .cover{aspect-ratio:4/3}\n.count-row{display:flex;gap:12px;font-size:11.5px;letter-spacing:.06em;color:var(--muted);margin-top:2px}\n.count-row b{color:var(--gold);font-weight:600}\n\n/* ---------- version card ---------- */\n.vcard .badges{position:absolute;top:9px;left:9px;display:flex;flex-wrap:wrap;gap:5px;max-width:calc(100% - 18px)}\n.badge{\n  font-size:10px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;\n  padding:4px 8px;border-radius:4px;background:rgba(12,10,7,.82);\n  border:1px solid var(--line);color:var(--gold);backdrop-filter:blur(4px);\n}\n.badge.limited{background:var(--gold);color:#171208;border-color:var(--gold)}\n.badge.excl{border-color:var(--cream);color:var(--cream)}\n.swatch{\n  position:absolute;bottom:9px;right:9px;width:28px;height:28px;border-radius:50%;\n  border:2px solid rgba(244,236,218,.75);box-shadow:0 3px 12px rgba(0,0,0,.6);\n}\n.vcard .rows{display:flex;flex-direction:column;gap:3px;font-size:12.5px;color:var(--muted);margin-top:2px}\n.vcard .rows div{display:flex;justify-content:space-between;gap:10px}\n.vcard .rows span:last-child{color:var(--cream);text-align:right}\n.price{font-family:var(--serif);font-size:20px;color:var(--gold);font-weight:600}\n.actions{display:flex;gap:7px;margin-top:12px;flex-wrap:wrap;align-items:center}\n.toggle{\n  border:1px solid var(--line);background:transparent;border-radius:999px;\n  padding:6px 12px;font-size:12px;letter-spacing:.05em;color:var(--muted);transition:.16s;\n}\n.toggle:hover{border-color:var(--gold);color:var(--gold)}\n.toggle.want.on{background:rgba(193,87,63,.18);border-color:var(--danger);color:#E0836D}\n.toggle.owned.on{background:rgba(111,154,99,.18);border-color:var(--ok);color:#9BC48F}\n.card-menu{margin-left:auto;display:flex;gap:4px}\n.mini{background:none;border:0;color:var(--muted);font-size:13px;padding:5px 6px;border-radius:6px;transition:.16s}\n.mini:hover{color:var(--gold);background:rgba(201,162,75,.1)}\n.mini.del:hover{color:var(--danger);background:rgba(193,87,63,.1)}\n\n/* ---------- states ---------- */\n.empty{\n  border:1px dashed var(--line);border-radius:var(--radius);padding:52px 24px;text-align:center;color:var(--muted);\n}\n.empty h3{font-family:var(--serif);font-size:24px;color:var(--cream);margin:0 0 8px;font-weight:600}\n.empty p{margin:0 auto 18px;max-width:400px;font-size:14px}\n.skel{border:1px solid var(--line);border-radius:var(--radius);height:230px;\n  background:linear-gradient(100deg,var(--ink-2) 30%,rgba(201,162,75,.07) 50%,var(--ink-2) 70%);\n  background-size:220% 100%;animation:sh 1.3s infinite}\n@keyframes sh{from{background-position:150% 0}to{background-position:-50% 0}}\n.err{border:1px solid rgba(193,87,63,.5);background:rgba(193,87,63,.09);border-radius:var(--radius);\n  padding:20px;color:#E9A996}\n.err b{color:#F4C7B8;display:block;margin-bottom:5px}\n.err code{font-size:12px;word-break:break-all;opacity:.85}\n\n/* ---------- modal ---------- */\n.mask{position:fixed;inset:0;background:rgba(4,3,2,.78);backdrop-filter:blur(4px);\n  z-index:60;display:flex;align-items:flex-end;justify-content:center;padding:0}\n@media(min-width:640px){.mask{align-items:center;padding:24px}}\n.modal{\n  background:var(--ink-2);border:1px solid var(--line);border-radius:18px 18px 0 0;\n  width:100%;max-width:560px;max-height:92vh;overflow-y:auto;box-shadow:var(--shadow);\n  padding:22px 20px calc(22px + env(safe-area-inset-bottom));\n}\n@media(min-width:640px){.modal{border-radius:18px;padding:26px}}\n.modal h3{font-family:var(--serif);font-size:25px;margin:0 0 4px;font-weight:600}\n.modal .hint{color:var(--muted);font-size:13px;margin:0 0 20px}\n.two{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}\n@media(max-width:520px){.two{grid-template-columns:1fr}}\n.checks{display:flex;flex-wrap:wrap;gap:18px;margin:2px 0 16px}\n.checks label{display:flex;align-items:center;gap:8px;font-size:13.5px;color:var(--muted);cursor:pointer}\n.checks input{width:17px;height:17px;accent-color:var(--gold);flex:none;padding:0}\n.modal-foot{display:flex;gap:10px;justify-content:flex-end;margin-top:8px;flex-wrap:wrap}\n\n/* ---------- toast / fab ---------- */\n#toasts{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(24px + env(safe-area-inset-bottom));\n  z-index:80;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;width:calc(100% - 32px);max-width:420px}\n.toast{background:var(--ink-3);border:1px solid var(--gold);color:var(--cream);border-radius:10px;\n  padding:11px 17px;font-size:13.5px;box-shadow:var(--shadow);animation:up .22s ease-out}\n.toast.bad{border-color:var(--danger);color:#EBB4A4}\n@keyframes up{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}\n.fab{position:fixed;right:18px;bottom:calc(18px + env(safe-area-inset-bottom));z-index:40;\n  width:54px;height:54px;border-radius:50%;background:var(--gold);color:#171208;border:0;\n  font-size:26px;line-height:1;display:grid;place-items:center;box-shadow:var(--shadow)}\n.fab:hover{background:#d8b25e}\n.sec-h{display:flex;align-items:center;gap:10px;margin:26px 0 12px;\n  font-size:11.5px;letter-spacing:.24em;text-transform:uppercase;color:var(--gold)}\n.sec-h::after{content:\"\";flex:1;height:1px;background:var(--line)}\n.hit{display:flex;align-items:center;gap:12px;width:100%;text-align:left;\n  border:1px solid var(--line);background:var(--ink-2);border-radius:12px;\n  padding:11px 14px;transition:.16s}\n.hit:hover{border-color:var(--gold);transform:translateY(-1px)}\n.hit-disc{width:32px;height:32px;border-radius:50%;flex:none;\n  background:radial-gradient(circle at 50% 50%, var(--gold) 0 16%, var(--ink-3) 17% 100%);\n  box-shadow:inset 0 0 0 1px var(--line)}\n.hit-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}\n.hit-name{display:block;font-size:14.5px;color:var(--cream);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.hit-meta{display:block;font-size:11.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.hit-go{font-size:12px;color:var(--gold);flex:none;letter-spacing:.05em}\n.hits{display:flex;flex-direction:column;gap:8px}\n.side{margin-bottom:16px}\n.side-h{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold);\n  border-bottom:1px solid var(--line);padding-bottom:5px;margin-bottom:6px}\n.trk{display:flex;gap:10px;align-items:baseline;padding:4px 0;font-size:13.5px}\n.trk-n{color:var(--gold);font-size:11.5px;min-width:26px;flex:none;letter-spacing:.04em}\n.trk-t{flex:1;color:var(--cream)}\n.trk-d{color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums;flex:none}\n.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}\n</style>\n</head>\n<body>\n\n<header class=\"top\">\n  <div class=\"top-inner\">\n    <button class=\"brand\" id=\"brand\" aria-label=\"回首頁\">\n      <span class=\"disc\"></span>\n      <h1>Vinyl<span>Vault</span></h1>\n    </button>\n    <div class=\"top-spacer\"></div>\n    <div class=\"stat-pill\" id=\"stats\" hidden></div>\n    <button class=\"icon-btn\" id=\"langBtn\" title=\"Language / 語言\" aria-label=\"Language\">EN</button>\n    <button class=\"icon-btn\" id=\"settingsBtn\" title=\"設定\" aria-label=\"設定\">⚙</button>\n  </div>\n</header>\n\n<main class=\"wrap\" id=\"app\"></main>\n<button class=\"fab\" id=\"fab\" hidden title=\"新增\">+</button>\n<div id=\"toasts\"></div>\n<div id=\"modalRoot\"></div>\n\n<script src=\"config.js\"></script>\n<script>\n(() => {\n'use strict';\n\n/* ========================================================================== */\n/* 語言                                                                        */\n/* 跟 ScrollScore / SightScore / HarmonyMap / LoudMaster 共用同一把 key，       */\n/* 在任一工具切過語言，開這個也會延續。                                          */\n/* ========================================================================== */\nconst LANG_KEY = 'sm_lang';\nlet LANG = 'zh';\ntry { LANG = localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'zh'; } catch { /* 隱私模式 */ }\n\n/** 英文字典。鍵就是中文原文，查不到時自動退回中文，不會出現空白。 */\nconst EN = {\n  // 導覽與統計\n  '歌手': 'Artists', '專輯': 'Albums', '版本': 'Pressings', '曲目': 'Tracks',\n  '我的收藏': 'My collection', '所有版本': 'All pressings',\n  '設定': 'Settings', '語言': 'Language',\n  '點進歌手查看專輯與版本': 'Open an artist to see their albums and pressings',\n  '打幾個字就直接查線上資料庫，選一位就把他所有黑膠抓進來':\n    'Type a few letters to search the online database — pick an artist and every vinyl pressing comes with them',\n  '輸入歌手名字，打幾個字就好…': 'Artist name — a few letters is enough…',\n  '線上資料庫': 'Online database',\n  '線上資料庫 · 點一下抓進來': 'Online database · tap to import',\n  '搜尋「{0}」…': 'Searching for “{0}”…',\n  '找不到符合「{0}」的歌手。': 'No artist matching “{0}”.',\n  '抓取 →': 'Import →',\n  '查不到線上資料': 'Online lookup failed',\n\n  // 空狀態\n  '收藏庫還是空的': 'Your collection is empty',\n  '在上面打一位歌手的名字 —— 打幾個字就好。找到他之後，歷年來所有黑膠發行、年份、地區、廠牌、Side A / Side B 曲目都會自動抓進來。':\n    'Type an artist name above — a few letters is enough. Once you pick them, every vinyl release they have put out arrives with its year, region, label and Side A / Side B tracklist already filled in.',\n  '還沒有專輯': 'No albums yet',\n  '幫 {0} 加入第一張專輯。': 'Add the first album for {0}.',\n  '還沒有任何版本': 'No pressings yet',\n  '加入第一個版本：顏色、限量、地區、售價都可以記錄。':\n    'Add the first pressing — colour, limited run, region and price all get recorded.',\n  '沒有符合篩選的版本': 'No pressings match this filter',\n  '換個篩選條件看看。': 'Try a different filter.',\n  '清除篩選': 'Clear filter',\n  '回歌手列表': 'Back to artists',\n\n  // 篩選與卡片\n  '全部': 'All', '限量': 'Limited', '獨佔通路': 'Exclusive to',\n  '所有地區': 'All regions', '地區': 'Region',\n  '顏色': 'Colour', '規格': 'Format', '發行': 'Released', '編號': 'Cat. no.',\n  '張': '', '專輯': 'Albums', '已收': 'owned', '想要': 'wanted',\n  '購買': 'Buy', '編輯': 'Edit', '刪除': 'Delete',\n\n  // 動作\n  '+ 手動新增': '+ Add manually', '新增': 'Add', '儲存': 'Save', '取消': 'Cancel',\n  '關閉': 'Close', '重試': 'Retry', '搜尋': 'Search', '處理中…': 'Working…',\n  '新增歌手': 'Add artist', '新增專輯': 'Add album', '新增版本': 'Add pressing',\n  '{0} 張專輯': '{0} albums', '{0} 個版本': '{0} pressings',\n  '從 MusicBrainz 匯入': 'Imported from MusicBrainz',\n  '編輯歌手': 'Edit artist', '編輯專輯': 'Edit album', '編輯版本': 'Edit pressing',\n  '連線設定': 'Connection settings', '測試連線': 'Test connection',\n  '匯出備份': 'Export backup', '匯入備份': 'Import backup',\n\n  // 表單\n  '歌手 / 團體名稱': 'Artist / group name', '排序名稱': 'Sort name', '國家': 'Country',\n  '圖片網址': 'Image URL', '備註': 'Notes', '收藏庫的第一層': 'The top level of your collection',\n  '專輯名稱': 'Album title', '發行年份': 'Release year', '廠牌': 'Label', '封面網址': 'Cover URL',\n  '版本名稱': 'Pressing name', '唱片顏色': 'Record colour', '顏色色票': 'Colour swatch',\n  '發行日期': 'Release date', '限量張數': 'Edition size', '售價': 'Price', '幣別': 'Currency',\n  '廠牌編號': 'Catalogue number', '購買連結': 'Buy link',\n  '顏色、限量、地區、售價、購買連結': 'Colour, limited run, region, price, buy link',\n  'Limited 限量': 'Limited', 'Exclusive 獨佔': 'Exclusive',\n  '❤ Want 想要': '❤ Want', '✓ Owned 已擁有': '✓ Owned',\n  '{0} 為必填': '{0} is required',\n\n  // 匯入\n  '從資料庫匯入': 'Import from database',\n  '輸入歌手名字，自動抓出他歷年來所有黑膠發行 —— 發行年份、地區、廠牌、曲目全都有。資料來自 MusicBrainz（免費的公開音樂資料庫）。':\n    'Enter an artist and every vinyl release they have put out is pulled in — year, region, label and tracklist included. Data comes from MusicBrainz, a free public music database.',\n  '歌手名稱': 'Artist name',\n  '例：Radiohead、周杰倫、Taylor Swift': 'e.g. Radiohead, Taylor Swift',\n  '搜尋中…': 'Searching…',\n  '選一位：': 'Pick one:',\n  '找不到「{0}」，換個寫法試試（例如用英文原名）。': 'Nothing found for “{0}” — try another spelling.',\n  '正在抓 {0} 的黑膠發行…': 'Fetching {0}’s vinyl releases…',\n  '正在抓 {0} 的黑膠發行… 已找到 {1} 張': 'Fetching {0}’s vinyl releases… {1} found so far',\n  'MusicBrainz 上查不到 {0} 的黑膠發行。': 'MusicBrainz has no vinyl releases for {0}.',\n  '找到 {0} 張黑膠': '{0} vinyl releases found',\n  '，年份 {0}–{1}': ', {0}–{1}',\n  '同時抓取曲目（每張約 1 秒，{0} 張約 {1} 秒）':\n    'Fetch tracklists too (about 1 second each — {0} releases, roughly {1} seconds)',\n  '全部匯入 {0} 張': 'Import all {0}',\n  '建立歌手…': 'Creating artist…',\n  '匯入中… {0} / {1}': 'Importing… {0} / {1}',\n  '抓取曲目… {0} / {1}（可以先關掉，之後點版本也會自動抓）':\n    'Fetching tracklists… {0} / {1} (you can close this — they load on demand later)',\n  '已匯入 {0}：{1} 張專輯、{2} 個版本': 'Imported {0}: {1} albums, {2} pressings',\n  '出錯了': 'Something went wrong',\n  '載入曲目…': 'Loading tracks…',\n  '這個版本還沒有曲目資料。': 'No tracklist for this pressing yet.',\n  '抓不到曲目': 'Could not load tracks',\n  '黑膠': 'Vinyl',\n\n  // 設定\n  '目前是<b style=\"color:var(--gold)\">本機模式</b>：資料存在這台裝置的瀏覽器裡，不用任何帳號就能用，但不會跟其他裝置同步。':\n    'You are in <b style=\"color:var(--gold)\">local mode</b>: data lives in this browser. No account needed, but it does not sync to your other devices.',\n  '目前是<b style=\"color:var(--gold)\">雲端模式</b>：資料存在你的資料庫，手機與電腦共用同一份。':\n    'You are in <b style=\"color:var(--gold)\">cloud mode</b>: data lives in your own database and is shared across your devices.',\n  'API 網址（留空 = 本機模式）': 'API URL (leave empty for local mode)',\n  '寫入權杖（選填）': 'Write token (optional)',\n  'Worker 沒設定保護就留空': 'Leave empty unless your Worker sets one',\n  '本機資料的備份 —— 換手機或清除瀏覽器資料前記得匯出。':\n    'Back up local data — export before switching phones or clearing browser data.',\n  '網址留空 = 本機模式，不需要連線。': 'Empty URL means local mode — no connection needed.',\n  '✓ 連線成功，資料庫正常': '✓ Connected, database healthy',\n  '✕ 有回應，但資料庫異常：{0}': '✕ Responded, but the database is not ready: {0}',\n  '✕ 連不上：{0}': '✕ Cannot connect: {0}',\n  '測試中…': 'Testing…',\n  '未設定 Turso 環境變數': 'Turso environment variables are not set',\n  '設定已儲存': 'Settings saved',\n  '備份已下載': 'Backup downloaded',\n  '已匯入備份': 'Backup imported',\n  '這不是 VinylVault 的備份檔': 'That is not a VinylVault backup file',\n\n  // 提示訊息\n  '已新增歌手': 'Artist added', '已新增專輯': 'Album added', '已新增版本': 'Pressing added',\n  '已更新': 'Updated', '已刪除': 'Deleted',\n  '已加入想要': 'Added to wanted', '已移除想要': 'Removed from wanted',\n  '已標記擁有': 'Marked as owned', '已取消擁有': 'No longer marked as owned',\n  '確認刪除': 'Confirm deletion',\n  '刪除「{0}」會同時刪掉底下所有專輯與版本，確定嗎？':\n    'Deleting “{0}” also removes every album and pressing under it. Continue?',\n  '刪除「{0}」會同時刪掉底下所有版本，確定嗎？':\n    'Deleting “{0}” also removes every pressing under it. Continue?',\n  '確定刪除版本「{0}」？': 'Delete the pressing “{0}”?',\n\n  // 表單範例\n  '例：Radiohead': 'e.g. Radiohead',\n  '例：UK': 'e.g. UK',\n  '例：In Rainbows': 'e.g. In Rainbows',\n  '例：XL Recordings': 'e.g. XL Recordings',\n  '例：Gold Nugget LP': 'e.g. Gold Nugget LP',\n  '例：Translucent Gold': 'e.g. Translucent Gold',\n  '例：US / UK / JP / TW': 'e.g. US / UK / JP / TW',\n  '例：Target': 'e.g. Target',\n  '例：12\" Vinyl': 'e.g. 12\" Vinyl',\n  '例：XLLP324': 'e.g. XLLP324',\n\n  // 錯誤\n  '載入失敗': 'Could not load',\n  '資料庫還沒有建立資料表': 'The database has no tables yet',\n  '按下面的按鈕，Worker 會自動幫你建好 artists / albums / versions 三張表。':\n    'Tap below and the Worker will create the artists / albums / versions tables for you.',\n  '建立資料表': 'Create tables', '建立並加入範例資料': 'Create with sample data',\n  '資料表已建立': 'Tables created',\n  '尚未設定 API 網址': 'No API URL configured',\n  '連線失敗，請確認 API 網址與 Worker 的 CORS 設定（{0}）':\n    'Connection failed — check the API URL and the Worker’s CORS settings ({0})',\n  '連不上音樂資料庫。{0}': 'Cannot reach the music database. {0}',\n  '連線失敗': 'connection failed',\n  '直連': 'direct', '轉送': 'relay', '：對方忙碌中': ': service busy',\n  '找不到這位歌手': 'Artist not found', '找不到這張專輯': 'Album not found',\n  '找不到這個版本': 'Pressing not found',\n  '缺少歌手': 'Artist is missing', '缺少專輯': 'Album is missing',\n  '歌手名稱為必填': 'Artist name is required',\n  '專輯名稱為必填': 'Album title is required',\n  '版本名稱為必填': 'Pressing name is required',\n  '無法儲存到這台裝置（可能是儲存空間已滿）：{0}':\n    'Could not save to this device (storage may be full): {0}',\n};\n\n/** 翻譯。{0}、{1} 會依序代入後面的參數。 */\nfunction t(zh, ...args) {\n  let out = LANG === 'en' ? (EN[zh] ?? zh) : zh;\n  args.forEach((v, i) => { out = out.split('{' + i + '}').join(String(v)); });\n  return out;\n}\n\nfunction setLang(lang) {\n  LANG = lang === 'en' ? 'en' : 'zh';\n  try { localStorage.setItem(LANG_KEY, LANG); } catch { /* 隱私模式 */ }\n  document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-Hant';\n  const btn = document.getElementById('langBtn');\n  if (btn) btn.textContent = LANG === 'en' ? '中' : 'EN';\n  const gear = document.getElementById('settingsBtn');\n  if (gear) { gear.title = t('設定'); gear.setAttribute('aria-label', t('設定')); }\n  render();\n}\n\n/* ========================================================================== */\n/* 設定                                                                        */\n/* ========================================================================== */\nconst CFG = window.VINYLVAULT_CONFIG || {};\nconst LS = { base: 'vv.apiBase', token: 'vv.writeToken' };\n\nconst qp = new URLSearchParams(location.search);\nif (qp.get('api')) localStorage.setItem(LS.base, qp.get('api').replace(/\\/+$/, ''));\n\nconst getBase  = () => (localStorage.getItem(LS.base) || CFG.apiBase || '').replace(/\\/+$/, '');\nconst getToken = () => localStorage.getItem(LS.token) || CFG.writeToken || '';\n\n/* ========================================================================== */\n/* API                                                                         */\n/* ========================================================================== */\nasync function api(path, { method = 'GET', body } = {}) {\n  const base = getBase();\n  if (!base) throw new Error(t('尚未設定 API 網址'));\n  const headers = {};\n  if (body) headers['Content-Type'] = 'application/json';\n  const token = getToken();\n  if (token && method !== 'GET') headers['Authorization'] = 'Bearer ' + token;\n\n  let res;\n  try {\n    res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });\n  } catch (e) {\n    throw new Error(t('連線失敗，請確認 API 網址與 Worker 的 CORS 設定（{0}）', e.message));\n  }\n  const text = await res.text();\n  let data = null;\n  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }\n  if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status + ' ' + text.slice(0, 160)));\n  return data;\n}\n\nconst Remote = {\n  stats:          ()             => api('/stats'),\n  artists:        (q)            => api('/artists' + (q ? '?q=' + encodeURIComponent(q) : '')),\n  artist:         (id)           => api('/artists/' + id),\n  createArtist:   (b)            => api('/artists', { method: 'POST', body: b }),\n  updateArtist:   (id, b)        => api('/artists/' + id, { method: 'PATCH', body: b }),\n  deleteArtist:   (id)           => api('/artists/' + id, { method: 'DELETE' }),\n  albums:         (artistId)     => api('/albums?artist_id=' + artistId),\n  album:          (id)           => api('/albums/' + id),\n  createAlbum:    (b)            => api('/albums', { method: 'POST', body: b }),\n  updateAlbum:    (id, b)        => api('/albums/' + id, { method: 'PATCH', body: b }),\n  deleteAlbum:    (id)           => api('/albums/' + id, { method: 'DELETE' }),\n  versions:       (qs)           => api('/versions' + (qs ? '?' + qs : '')),\n  createVersion:  (b)            => api('/versions', { method: 'POST', body: b }),\n  updateVersion:  (id, b)        => api('/versions/' + id, { method: 'PATCH', body: b }),\n  deleteVersion:  (id)           => api('/versions/' + id, { method: 'DELETE' }),\n  tracks:         (id)           => api('/versions/' + id + '/tracks'),\n  setTracks:      (id, tracks)   => api('/versions/' + id + '/tracks', { method: 'PUT', body: { tracks } }),\n};\n\n/* ========================================================================== */\n/* 本機模式：沒有設定 API 網址時，資料存在這台裝置的瀏覽器裡                     */\n/* 介面跟 Remote 完全一樣，所以上層畫面不用知道自己在哪個模式                    */\n/* ========================================================================== */\nconst DB_KEY = 'vv.db';\n\nconst blank = () => ({ artists: [], albums: [], versions: [], tracks: [], seq: 0 });\n\nfunction load() {\n  try {\n    const raw = localStorage.getItem(DB_KEY);\n    if (!raw) return blank();\n    const d = JSON.parse(raw);\n    return {\n      artists: d.artists || [], albums: d.albums || [],\n      versions: d.versions || [], tracks: d.tracks || [], seq: d.seq || 0,\n    };\n  } catch { return blank(); }\n}\n\nfunction save(d) {\n  try { localStorage.setItem(DB_KEY, JSON.stringify(d)); }\n  catch (e) { throw new Error(t('無法儲存到這台裝置（可能是儲存空間已滿）：{0}', e.message)); }\n}\n\nconst nowStamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');\nconst clone = (o) => JSON.parse(JSON.stringify(o));\nconst bit = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);\n\nfunction numOrNull(v) {\n  if (v === null || v === undefined || v === '') return null;\n  const n = Number(v);\n  return Number.isFinite(n) ? n : null;\n}\n\n/** 只寫入白名單欄位，並做型別轉換 */\nfunction apply(target, body, fields) {\n  for (const [key, cast] of Object.entries(fields)) {\n    if (Object.prototype.hasOwnProperty.call(body, key)) target[key] = cast(body[key]);\n  }\n  target.updated_at = nowStamp();\n  return target;\n}\n\nconst strOrNull = (v) => {\n  if (v === null || v === undefined) return null;\n  const t = String(v).trim();\n  return t === '' ? null : t;\n};\nconst intOrNull = (v) => { const n = numOrNull(v); return n === null ? null : Math.trunc(n); };\n\nconst F_ARTIST  = { name: strOrNull, sort_name: strOrNull, country: strOrNull, image_url: strOrNull, notes: strOrNull, mb_id: strOrNull };\nconst F_ALBUM   = { artist_id: intOrNull, title: strOrNull, release_year: intOrNull, cover_url: strOrNull, label: strOrNull, notes: strOrNull, mb_id: strOrNull };\nconst F_VERSION = {\n  album_id: intOrNull, name: strOrNull, cover_url: strOrNull, color: strOrNull, color_hex: strOrNull,\n  is_limited: bit, is_exclusive: bit, exclusive_to: strOrNull, region: strOrNull,\n  release_date: strOrNull, edition_size: intOrNull, price: numOrNull, currency: strOrNull,\n  buy_url: strOrNull, want: bit, owned: bit, notes: strOrNull,\n  format: strOrNull, catalog_no: strOrNull, mb_id: strOrNull, tracks_loaded: bit,\n};\n\n/** 從唱片編號取出面別：A1 -> A */\nconst sideOf = (n) => { const m = /^\\s*([A-Za-z])/.exec(n || ''); return m ? m[1].toUpperCase() : null; };\n\nconst byId = (list, id) => list.find((x) => x.id === Number(id));\n\nfunction decorateAlbum(d, al) {\n  const vs = d.versions.filter((v) => v.album_id === al.id);\n  return {\n    ...al,\n    artist_name: byId(d.artists, al.artist_id)?.name ?? '',\n    version_count: vs.length,\n    owned_count: vs.filter((v) => v.owned).length,\n    want_count: vs.filter((v) => v.want).length,\n  };\n}\n\nfunction decorateVersion(d, v) {\n  const al = byId(d.albums, v.album_id);\n  const ar = al ? byId(d.artists, al.artist_id) : null;\n  return {\n    ...v,\n    album_title: al?.title ?? '',\n    album_cover_url: al?.cover_url ?? null,\n    artist_id: ar?.id ?? null,\n    artist_name: ar?.name ?? '',\n  };\n}\n\nconst Local = {\n  async stats() {\n    const d = load();\n    return {\n      artists: d.artists.length, albums: d.albums.length, versions: d.versions.length,\n      want: d.versions.filter((v) => v.want).length,\n      owned: d.versions.filter((v) => v.owned).length,\n    };\n  },\n\n  async artists(q) {\n    const d = load();\n    const kw = (q || '').toLowerCase();\n    return d.artists\n      .filter((a) => !kw || a.name.toLowerCase().includes(kw))\n      .map((a) => {\n        const als = d.albums.filter((al) => al.artist_id === a.id);\n        const ids = als.map((al) => al.id);\n        const vs = d.versions.filter((v) => ids.includes(v.album_id));\n        return { ...a, album_count: als.length, version_count: vs.length, owned_count: vs.filter((v) => v.owned).length };\n      })\n      .sort((x, y) => (x.sort_name || x.name).localeCompare(y.sort_name || y.name, 'zh-Hant'));\n  },\n\n  async artist(id) {\n    const a = byId(load().artists, id);\n    if (!a) throw new Error(t('找不到這位歌手'));\n    return clone(a);\n  },\n\n  async createArtist(body) {\n    const d = load();\n    if (!strOrNull(body.name)) throw new Error(t('歌手名稱為必填'));\n    const row = apply({ id: ++d.seq, created_at: nowStamp() }, body, F_ARTIST);\n    d.artists.push(row); save(d);\n    return clone(row);\n  },\n\n  async updateArtist(id, body) {\n    const d = load();\n    const a = byId(d.artists, id);\n    if (!a) throw new Error('找不到這位歌手');\n    apply(a, body, F_ARTIST); save(d);\n    return clone(a);\n  },\n\n  async deleteArtist(id) {\n    const d = load();\n    const n = Number(id);\n    const albumIds = d.albums.filter((al) => al.artist_id === n).map((al) => al.id);\n    const versionIds = d.versions.filter((v) => albumIds.includes(v.album_id)).map((v) => v.id);\n    d.tracks = d.tracks.filter((t) => !versionIds.includes(t.version_id));\n    d.versions = d.versions.filter((v) => !albumIds.includes(v.album_id));\n    d.albums = d.albums.filter((al) => al.artist_id !== n);\n    d.artists = d.artists.filter((a) => a.id !== n);\n    save(d);\n    return { deleted: true, id: n };\n  },\n\n  async albums(artistId) {\n    const d = load();\n    return d.albums\n      .filter((al) => al.artist_id === Number(artistId))\n      .map((al) => decorateAlbum(d, al))\n      .sort((x, y) => (y.release_year || 0) - (x.release_year || 0) || x.title.localeCompare(y.title, 'zh-Hant'));\n  },\n\n  async album(id) {\n    const d = load();\n    const al = byId(d.albums, id);\n    if (!al) throw new Error(t('找不到這張專輯'));\n    return decorateAlbum(d, al);\n  },\n\n  async createAlbum(body) {\n    const d = load();\n    if (intOrNull(body.artist_id) === null) throw new Error(t('缺少歌手'));\n    if (!strOrNull(body.title)) throw new Error(t('專輯名稱為必填'));\n    const row = apply({ id: ++d.seq, created_at: nowStamp() }, body, F_ALBUM);\n    d.albums.push(row); save(d);\n    return clone(row);\n  },\n\n  async updateAlbum(id, body) {\n    const d = load();\n    const al = byId(d.albums, id);\n    if (!al) throw new Error('找不到這張專輯');\n    apply(al, body, F_ALBUM); save(d);\n    return clone(al);\n  },\n\n  async deleteAlbum(id) {\n    const d = load();\n    const n = Number(id);\n    const versionIds = d.versions.filter((v) => v.album_id === n).map((v) => v.id);\n    d.tracks = d.tracks.filter((t) => !versionIds.includes(t.version_id));\n    d.versions = d.versions.filter((v) => v.album_id !== n);\n    d.albums = d.albums.filter((al) => al.id !== n);\n    save(d);\n    return { deleted: true, id: n };\n  },\n\n  async versions(qs) {\n    const d = load();\n    const p = new URLSearchParams(qs || '');\n    const albumId = p.get('album_id');\n    const artistId = p.get('artist_id');\n    const region = p.get('region');\n    return d.versions\n      .map((v) => decorateVersion(d, v))\n      .filter((v) => {\n        if (albumId !== null && v.album_id !== Number(albumId)) return false;\n        if (artistId !== null && v.artist_id !== Number(artistId)) return false;\n        if (region && v.region !== region) return false;\n        for (const key of ['want', 'owned', 'is_limited', 'is_exclusive']) {\n          if (p.get(key) !== null && v[key] !== bit(p.get(key))) return false;\n        }\n        return true;\n      })\n      .sort((x, y) => String(y.release_date || '').localeCompare(String(x.release_date || '')) ||\n                      x.name.localeCompare(y.name, 'zh-Hant'));\n  },\n\n  async createVersion(body) {\n    const d = load();\n    if (intOrNull(body.album_id) === null) throw new Error(t('缺少專輯'));\n    if (!strOrNull(body.name)) throw new Error(t('版本名稱為必填'));\n    const row = apply({ id: ++d.seq, created_at: nowStamp(), currency: 'USD' }, body, F_VERSION);\n    d.versions.push(row); save(d);\n    return clone(row);\n  },\n\n  async updateVersion(id, body) {\n    const d = load();\n    const v = byId(d.versions, id);\n    if (!v) throw new Error(t('找不到這個版本'));\n    apply(v, body, F_VERSION); save(d);\n    return clone(v);\n  },\n\n  async deleteVersion(id) {\n    const d = load();\n    const n = Number(id);\n    d.versions = d.versions.filter((v) => v.id !== n);\n    d.tracks = d.tracks.filter((t) => t.version_id !== n);\n    save(d);\n    return { deleted: true, id: n };\n  },\n\n  async tracks(versionId) {\n    const d = load();\n    return d.tracks.filter((t) => t.version_id === Number(versionId))\n                   .sort((a, b) => a.position - b.position);\n  },\n\n  async setTracks(versionId, list) {\n    const d = load();\n    const n = Number(versionId);\n    const v = byId(d.versions, n);\n    if (!v) throw new Error('找不到這個版本');\n    d.tracks = d.tracks.filter((t) => t.version_id !== n);\n    let pos = 0;\n    for (const t of list) {\n      const title = strOrNull(t.title);\n      if (!title) continue;\n      const number = strOrNull(t.number);\n      d.tracks.push({\n        id: ++d.seq, version_id: n, position: ++pos,\n        side: strOrNull(t.side) || sideOf(number), number, title,\n        length_ms: intOrNull(t.length_ms),\n      });\n    }\n    v.tracks_loaded = 1;\n    save(d);\n    return d.tracks.filter((t) => t.version_id === n);\n  },\n};\n\n/** 有填 API 網址就走雲端，沒有就用這台裝置的本機資料。 */\nconst API = new Proxy({}, { get: (_t, key) => (getBase() ? Remote : Local)[key] });\nconst isLocal = () => !getBase();\n\n/* ========================================================================== */\n/* MusicBrainz —— 免費的公開音樂資料庫，不需要申請金鑰                          */\n/* 直接從瀏覽器呼叫，所以本機模式也能用                                          */\n/* ========================================================================== */\nconst MB = 'https://musicbrainz.org/ws/2';\nconst CAA = 'https://coverartarchive.org';\n\n/** MusicBrainz 要求每秒最多一次請求，這裡排隊處理。 */\nlet mbChain = Promise.resolve();\nlet mbLast = 0;\n\n/**\n * 依序嘗試幾條路徑，只要有一條通就好：\n *   1. 有設定 Worker 的話走自己的 Worker（最穩，不受瀏覽器跨網域限制）\n *   2. 直接連 MusicBrainz\n *   3. 公開的跨網域轉送服務（前兩條都被擋時的最後手段）\n */\nfunction mbRoutes(query) {\n  const direct = MB + query;\n  const base = getBase();\n  const list = [];\n  if (base) list.push({ label: 'Worker', url: base + '/mb?path=' + encodeURIComponent(query) });\n  list.push({ label: t('直連'), url: direct });\n  list.push({ label: t('轉送'), url: 'https://api.allorigins.win/raw?url=' + encodeURIComponent(direct) });\n  return list;\n}\n\nfunction mbFetch(path) {\n  const query = path + (path.includes('?') ? '&' : '?') + 'fmt=json';\n  const run = async () => {\n    const wait = Math.max(0, 1100 - (Date.now() - mbLast));\n    if (wait) await new Promise((r) => setTimeout(r, wait));\n    mbLast = Date.now();\n\n    const problems = [];\n    for (const route of mbRoutes(query)) {\n      try {\n        const res = await fetch(route.url, { headers: { Accept: 'application/json' } });\n        if (res.status === 503) { problems.push(route.label + t('：對方忙碌中')); continue; }\n        if (!res.ok) { problems.push(route.label + '：HTTP ' + res.status); continue; }\n        const data = await res.json();\n        if (data && (data.error || data.message) && !data.artists && !data.releases && !data.media) {\n          problems.push(route.label + '：' + (data.error || data.message));\n          continue;\n        }\n        return data;\n      } catch (e) {\n        problems.push(route.label + '：' + (e.message || t('連線失敗')));\n      }\n    }\n    throw new Error(t('連不上音樂資料庫。{0}', problems.join('；')));\n  };\n  mbChain = mbChain.then(run, run);\n  return mbChain;\n}\n\nconst VINYL = /vinyl|lp\\b|\\bep\\b.*vinyl|shellac/i;\n\n/** Lucene 的保留字元要拿掉，不然使用者打個問號就整串查詢壞掉 */\nconst luceneSafe = (s) => String(s).replace(/[+\\-&|!(){}\\[\\]^\"~*?:\\\\/]/g, ' ').trim();\n\n/**\n * 搜尋歌手。prefix = true 時做前綴比對，\n * 打「Ari」就能找到 Ariana Grande。\n */\nasync function mbSearchArtists(name, { prefix = false, limit = 8 } = {}) {\n  const clean = luceneSafe(name);\n  if (!clean) return [];\n  const q = prefix ? clean + '*' : clean;\n  const d = await mbFetch('/artist?query=' + encodeURIComponent(q) + '&limit=' + limit);\n  return (d.artists || []).map((a) => ({\n    mb_id: a.id,\n    name: a.name,\n    score: a.score ?? 0,\n    country: a.country || a.area?.name || null,\n    type: a.type || null,\n    hint: a.disambiguation || '',\n    began: a['life-span']?.begin ? a['life-span'].begin.slice(0, 4) : null,\n  }));\n}\n\n/** 抓一位歌手所有「黑膠」發行（分頁抓完） */\nasync function mbVinylReleases(artistMbid, onProgress) {\n  const out = [];\n  const seen = new Set();\n  let offset = 0;\n  for (let page = 0; page < 12; page++) {\n    const d = await mbFetch('/release?artist=' + artistMbid +\n      '&inc=media+release-groups+labels&limit=100&offset=' + offset);\n    const list = d.releases || [];\n    for (const r of list) {\n      const media = r.media || [];\n      const fmt = media.map((m) => m.format).filter(Boolean).join(' + ');\n      if (!VINYL.test(fmt)) continue;\n      const key = (r['release-group']?.title || r.title) + '|' + (r.date || '') + '|' + (r.country || '') + '|' + fmt;\n      if (seen.has(key)) continue;\n      seen.add(key);\n      const label = r['label-info']?.[0];\n      out.push({\n        mb_id: r.id,\n        title: r.title,\n        group_title: r['release-group']?.title || r.title,\n        group_id: r['release-group']?.id || null,\n        primary_type: r['release-group']?.['primary-type'] || null,\n        date: r.date || null,\n        year: r.date ? Number(r.date.slice(0, 4)) : null,\n        country: r.country || null,\n        format: fmt || null,\n        disambiguation: r.disambiguation || null,\n        label: label?.label?.name || null,\n        catalog_no: label?.['catalog-number'] || null,\n        track_count: media.reduce((n, m) => n + (m['track-count'] || 0), 0),\n      });\n    }\n    if (onProgress) onProgress(out.length, d['release-count'] || list.length);\n    offset += 100;\n    if (offset >= (d['release-count'] || 0)) break;\n  }\n  out.sort((a, b) => (a.year || 9999) - (b.year || 9999) ||\n                     String(a.title).localeCompare(String(b.title)));\n  return out;\n}\n\n/** 抓某一張發行的曲目（含 A1 / B2 這種面別編號） */\nasync function mbTracks(releaseMbid) {\n  const d = await mbFetch('/release/' + releaseMbid + '?inc=recordings+media');\n  const out = [];\n  for (const m of d.media || []) {\n    for (const t of m.tracks || []) {\n      out.push({\n        number: t.number || null,\n        title: t.title || t.recording?.title || '',\n        length_ms: t.length ?? t.recording?.length ?? null,\n      });\n    }\n  }\n  return out;\n}\n\nconst caaCover = (mbid, size) => CAA + '/release/' + mbid + '/front-' + (size || 500);\n\nconst mmss = (ms) => {\n  if (!ms && ms !== 0) return '';\n  const total = Math.round(ms / 1000);\n  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');\n};\n\n/* ========================================================================== */\n/* 小工具                                                                      */\n/* ========================================================================== */\nconst $ = (sel, root = document) => root.querySelector(sel);\nconst app = $('#app'), modalRoot = $('#modalRoot'), fab = $('#fab');\n\nconst esc = (s) => String(s ?? '').replace(/[&<>\"']/g, (c) =>\n  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c]));\n\nconst attr = (s) => esc(s);\n\nfunction safeUrl(u) {\n  const s = String(u ?? '').trim();\n  return /^https?:\\/\\//i.test(s) ? s : '';\n}\n\nfunction money(price, currency) {\n  if (price === null || price === undefined || price === '') return '';\n  const cur = currency || 'USD';\n  try {\n    return new Intl.NumberFormat('zh-Hant', { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(price);\n  } catch { return cur + ' ' + price; }\n}\n\nfunction toast(msg, bad = false) {\n  const el = document.createElement('div');\n  el.className = 'toast' + (bad ? ' bad' : '');\n  el.textContent = msg;\n  $('#toasts').appendChild(el);\n  setTimeout(() => el.remove(), bad ? 4200 : 2400);\n}\n\nfunction coverHtml(url, extra = '') {\n  const u = safeUrl(url);\n  return u\n    ? '<div class=\"cover\">' + extra + '<img loading=\"lazy\" src=\"' + attr(u) + '\" alt=\"\" onerror=\"this.parentNode.classList.add(\\'ph\\');this.remove()\"></div>'\n    : '<div class=\"cover ph\">' + extra + '</div>';\n}\n\nconst go = (hash) => { location.hash = hash; };\n\n/* ========================================================================== */\n/* 表單 modal                                                                  */\n/* ========================================================================== */\nfunction openModal(html) {\n  const mask = document.createElement('div');\n  mask.className = 'mask';\n  mask.innerHTML = '<div class=\"modal\" role=\"dialog\" aria-modal=\"true\">' + html + '</div>';\n  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });\n  const onKey = (e) => { if (e.key === 'Escape') close(); };\n  document.addEventListener('keydown', onKey);\n  function close() { document.removeEventListener('keydown', onKey); mask.remove(); }\n  modalRoot.appendChild(mask);\n  const first = mask.querySelector('input,select,textarea');\n  if (first) setTimeout(() => first.focus(), 40);\n  return { el: mask, close };\n}\n\n/**\n * 依欄位定義產生表單。\n * fields: [{ key, label, type, options?, placeholder?, required?, half? }]\n */\nfunction formModal({ title, hint, fields, values = {}, submitLabel = t('儲存'), onSubmit }) {\n  const render = (f) => {\n    const v = values[f.key];\n    const id = 'f_' + f.key;\n    if (f.type === 'check') return '';\n    let control;\n    if (f.type === 'textarea') {\n      control = '<textarea id=\"' + id + '\" name=\"' + f.key + '\" placeholder=\"' + attr(f.placeholder || '') + '\">' + esc(v ?? '') + '</textarea>';\n    } else if (f.type === 'select') {\n      control = '<select id=\"' + id + '\" name=\"' + f.key + '\">' +\n        f.options.map((o) => '<option value=\"' + attr(o.value) + '\"' +\n          (String(v ?? '') === String(o.value) ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('') +\n        '</select>';\n    } else {\n      control = '<input id=\"' + id + '\" name=\"' + f.key + '\" type=\"' + (f.type || 'text') + '\"' +\n        (f.type === 'number' ? ' step=\"any\"' : '') +\n        (f.required ? ' required' : '') +\n        ' placeholder=\"' + attr(f.placeholder || '') + '\" value=\"' + attr(v ?? '') + '\">';\n    }\n    return '<label class=\"fld\"><span>' + esc(f.label) + (f.required ? ' *' : '') + '</span>' + control + '</label>';\n  };\n\n  const checks = fields.filter((f) => f.type === 'check');\n  const singles = fields.filter((f) => f.type !== 'check' && !f.half);\n  const halves = fields.filter((f) => f.type !== 'check' && f.half);\n\n  const html =\n    '<h3>' + esc(title) + '</h3>' +\n    (hint ? '<p class=\"hint\">' + esc(hint) + '</p>' : '<p class=\"hint\"></p>') +\n    '<form id=\"vvForm\" novalidate>' +\n      singles.map(render).join('') +\n      (halves.length ? '<div class=\"two\">' + halves.map(render).join('') + '</div>' : '') +\n      (checks.length ? '<div class=\"checks\">' + checks.map((f) =>\n        '<label><input type=\"checkbox\" name=\"' + f.key + '\"' + (values[f.key] ? ' checked' : '') + '>' + esc(f.label) + '</label>').join('') + '</div>' : '') +\n      '<div class=\"modal-foot\">' +\n        '<button type=\"button\" class=\"btn ghost\" data-close>' + t('取消') + '</button>' +\n        '<button type=\"submit\" class=\"btn primary\">' + esc(submitLabel) + '</button>' +\n      '</div>' +\n    '</form>';\n\n  const m = openModal(html);\n  m.el.querySelector('[data-close]').onclick = m.close;\n  const form = m.el.querySelector('#vvForm');\n\n  form.onsubmit = async (e) => {\n    e.preventDefault();\n    const out = {};\n    for (const f of fields) {\n      const input = form.elements[f.key];\n      if (!input) continue;\n      if (f.type === 'check') { out[f.key] = input.checked ? 1 : 0; continue; }\n      const raw = String(input.value ?? '').trim();\n      if (f.required && !raw) { toast(t('{0} 為必填', f.label), true); input.focus(); return; }\n      out[f.key] = raw === '' ? null : (f.type === 'number' ? Number(raw) : raw);\n    }\n    const btn = form.querySelector('button[type=submit]');\n    btn.disabled = true; btn.textContent = t('處理中…');\n    try {\n      await onSubmit(out);\n      m.close();\n    } catch (err) {\n      toast(err.message, true);\n      btn.disabled = false; btn.textContent = submitLabel;\n    }\n  };\n  return m;\n}\n\nfunction confirmModal(text, onYes) {\n  const m = openModal(\n    '<h3>' + t('確認刪除') + '</h3><p class=\"hint\">' + esc(text) + '</p>' +\n    '<div class=\"modal-foot\"><button class=\"btn ghost\" data-no>' + t('取消') + '</button>' +\n    '<button class=\"btn danger\" data-yes style=\"border-color:var(--danger);color:#E0836D\">' + t('刪除') + '</button></div>');\n  m.el.querySelector('[data-no]').onclick = m.close;\n  m.el.querySelector('[data-yes]').onclick = async () => {\n    try { await onYes(); m.close(); } catch (e) { toast(e.message, true); }\n  };\n}\n\n/* ========================================================================== */\n/* 設定畫面                                                                    */\n/* ========================================================================== */\nfunction openSettings() {\n  const local = isLocal();\n  const m = openModal(\n    '<h3>' + t('設定') + '</h3>' +\n    '<p class=\"hint\">' + (local\n      ? t('目前是<b style=\"color:var(--gold)\">本機模式</b>：資料存在這台裝置的瀏覽器裡，不用任何帳號就能用，但不會跟其他裝置同步。')\n      : t('目前是<b style=\"color:var(--gold)\">雲端模式</b>：資料存在你的資料庫，手機與電腦共用同一份。')) + '</p>' +\n    '<label class=\"fld\"><span>' + t('API 網址（留空 = 本機模式）') + '</span>' +\n      '<input id=\"sBase\" placeholder=\"https://…workers.dev\" value=\"' + attr(getBase()) + '\"></label>' +\n    '<label class=\"fld\"><span>' + t('寫入權杖（選填）') + '</span>' +\n      '<input id=\"sToken\" type=\"password\" placeholder=\"' + attr(t('Worker 沒設定保護就留空')) + '\" value=\"' + attr(getToken()) + '\"></label>' +\n    '<div id=\"sTest\" class=\"hint\"></div>' +\n    (local\n      ? '<div style=\"border-top:1px solid var(--line);margin:18px 0 14px;padding-top:16px\">' +\n        '<p class=\"hint\" style=\"margin-bottom:10px\">' + t('本機資料的備份 —— 換手機或清除瀏覽器資料前記得匯出。') + '</p>' +\n        '<div style=\"display:flex;gap:8px;flex-wrap:wrap\">' +\n          '<button class=\"btn sm\" id=\"sExport\">' + t('匯出備份') + '</button>' +\n          '<button class=\"btn sm\" id=\"sImport\">' + t('匯入備份') + '</button>' +\n          '<input type=\"file\" id=\"sFile\" accept=\"application/json,.json\" hidden>' +\n        '</div></div>'\n      : '') +\n    '<div class=\"modal-foot\">' +\n      '<button class=\"btn ghost\" data-close>' + t('取消') + '</button>' +\n      '<button class=\"btn\" id=\"sPing\">' + t('測試連線') + '</button>' +\n      '<button class=\"btn primary\" id=\"sSave\">' + t('儲存') + '</button>' +\n    '</div>');\n\n  const baseEl = m.el.querySelector('#sBase');\n  const tokEl = m.el.querySelector('#sToken');\n  const out = m.el.querySelector('#sTest');\n  m.el.querySelector('[data-close]').onclick = m.close;\n\n  m.el.querySelector('#sPing').onclick = async () => {\n    const url = baseEl.value.trim().replace(/\\/+$/, '');\n    if (!url) { out.innerHTML = '<span style=\"color:var(--muted)\">' + t('網址留空 = 本機模式，不需要連線。') + '</span>'; return; }\n    out.textContent = t('測試中…');\n    try {\n      const j = await (await fetch(url + '/health')).json();\n      out.innerHTML = j.ok\n        ? '<span style=\"color:var(--ok)\">' + t('✓ 連線成功，資料庫正常') + '</span>'\n        : '<span style=\"color:var(--danger)\">' + esc(t('✕ 有回應，但資料庫異常：{0}', j.db || t('未設定 Turso 環境變數'))) + '</span>';\n    } catch (e) {\n      out.innerHTML = '<span style=\"color:var(--danger)\">' + esc(t('✕ 連不上：{0}', e.message)) + '</span>';\n    }\n  };\n\n  const exportBtn = m.el.querySelector('#sExport');\n  if (exportBtn) {\n    exportBtn.onclick = () => {\n      const blob = new Blob([localStorage.getItem(DB_KEY) || JSON.stringify(blank())],\n        { type: 'application/json' });\n      const a = document.createElement('a');\n      a.href = URL.createObjectURL(blob);\n      a.download = 'vinylvault-' + new Date().toISOString().slice(0, 10) + '.json';\n      a.click();\n      setTimeout(() => URL.revokeObjectURL(a.href), 1000);\n      toast(t('備份已下載'));\n    };\n    const fileEl = m.el.querySelector('#sFile');\n    m.el.querySelector('#sImport').onclick = () => fileEl.click();\n    fileEl.onchange = async () => {\n      const f = fileEl.files[0];\n      if (!f) return;\n      try {\n        const data = JSON.parse(await f.text());\n        if (!Array.isArray(data.artists)) throw new Error(t('這不是 VinylVault 的備份檔'));\n        save({ artists: data.artists, albums: data.albums || [], versions: data.versions || [],\n               seq: data.seq || 0 });\n        m.close(); toast(t('已匯入備份')); render();\n      } catch (e) { toast(e.message, true); }\n    };\n  }\n\n  m.el.querySelector('#sSave').onclick = () => {\n    localStorage.setItem(LS.base, baseEl.value.trim().replace(/\\/+$/, ''));\n    localStorage.setItem(LS.token, tokEl.value.trim());\n    m.close();\n    toast(t('設定已儲存'));\n    render();\n  };\n}\n\n$('#settingsBtn').onclick = openSettings;\n$('#langBtn').onclick = () => setLang(LANG === 'en' ? 'zh' : 'en');\n// 開頁時把按鈕與 <html lang> 對到已儲存的偏好（setLang 會 render，這裡不能直接呼叫）\ndocument.documentElement.lang = LANG === 'en' ? 'en' : 'zh-Hant';\n$('#langBtn').textContent = LANG === 'en' ? '中' : 'EN';\n$('#brand').onclick = () => go('#/');\n\n/* ========================================================================== */\n/* 畫面片段                                                                    */\n/* ========================================================================== */\nconst skeletons = (n, cls) =>\n  '<div class=\"grid ' + cls + '\">' + Array.from({ length: n }, () => '<div class=\"skel\"></div>').join('') + '</div>';\n\nfunction crumbs(items) {\n  return '<nav class=\"crumbs\">' + items.map((it, i) =>\n    (i ? '<span class=\"sep\">/</span>' : '') +\n    (it.hash ? '<button data-go=\"' + attr(it.hash) + '\">' + esc(it.label) + '</button>'\n             : '<span class=\"cur\">' + esc(it.label) + '</span>')).join('') + '</nav>';\n}\n\nfunction pageHead(eyebrow, title, sub, actionsHtml = '') {\n  return '<div class=\"page-head\"><div class=\"titles\">' +\n    (eyebrow ? '<p class=\"eyebrow\">' + esc(eyebrow) + '</p>' : '') +\n    '<h2 class=\"title\">' + esc(title) + '</h2>' +\n    (sub ? '<div class=\"sub\">' + esc(sub) + '</div>' : '') +\n    '</div>' + (actionsHtml ? '<div style=\"display:flex;gap:8px;flex-wrap:wrap\">' + actionsHtml + '</div>' : '') +\n    '</div><div class=\"rule\"></div>';\n}\n\nconst emptyState = (title, text, btn) =>\n  '<div class=\"empty\"><h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' + (btn || '') + '</div>';\n\nfunction errorState(err) {\n  const needsSetup = /no such table|no such column/i.test(err.message);\n  return '<div class=\"err\">' +\n    (needsSetup\n      ? '<b>' + t('資料庫還沒有建立資料表') + '</b><p style=\"margin:0 0 4px\">' + t('按下面的按鈕，Worker 會自動幫你建好 artists / albums / versions 三張表。') + '</p>'\n      : '<b>' + t('載入失敗') + '</b>') +\n    '<code>' + esc(err.message) + '</code>' +\n    '<div style=\"margin-top:14px;display:flex;gap:8px;flex-wrap:wrap\">' +\n    (needsSetup ? '<button class=\"btn sm primary\" data-setup>' + t('建立資料表') + '</button>' +\n                  '<button class=\"btn sm\" data-setup-seed>' + t('建立並加入範例資料') + '</button>' : '') +\n    '<button class=\"btn sm\" data-retry>' + t('重試') + '</button>' +\n    '<button class=\"btn sm\" data-settings>' + t('連線設定') + '</button></div></div>';\n}\n\nasync function runSetup(seed) {\n  try {\n    const r = await api('/setup' + (seed ? '?seed=1' : ''), { method: 'POST' });\n    toast(r.message || t('資料表已建立'));\n    render();\n  } catch (e) { toast(e.message, true); }\n}\n\n/* ========================================================================== */\n/* 表單定義                                                                    */\n/* ========================================================================== */\nconst artistFields = [\n  { key: 'name', label: t('歌手 / 團體名稱'), required: true, placeholder: t('例：Radiohead') },\n  { key: 'sort_name', label: t('排序名稱'), half: true, placeholder: t('例：Radiohead') },\n  { key: 'country', label: t('國家'), half: true, placeholder: t('例：UK') },\n  { key: 'image_url', label: t('圖片網址'), placeholder: t('https://…') },\n  { key: 'notes', label: t('備註'), type: 'textarea' },\n];\n\nconst albumFields = [\n  { key: 'title', label: t('專輯名稱'), required: true, placeholder: t('例：In Rainbows') },\n  { key: 'release_year', label: t('發行年份'), type: 'number', half: true, placeholder: t('2007') },\n  { key: 'label', label: t('廠牌'), half: true, placeholder: t('例：XL Recordings') },\n  { key: 'cover_url', label: t('封面網址'), placeholder: t('https://…') },\n  { key: 'notes', label: t('備註'), type: 'textarea' },\n];\n\nconst versionFields = [\n  { key: 'name', label: t('版本名稱'), required: true, placeholder: t('例：Gold Nugget LP') },\n  { key: 'cover_url', label: t('封面網址'), placeholder: t('https://…') },\n  { key: 'color', label: t('唱片顏色'), half: true, placeholder: t('例：Translucent Gold') },\n  { key: 'color_hex', label: t('顏色色票'), type: 'color', half: true },\n  { key: 'region', label: t('地區'), half: true, placeholder: t('例：US / UK / JP / TW') },\n  { key: 'release_date', label: t('發行日期'), type: 'date', half: true },\n  { key: 'edition_size', label: t('限量張數'), type: 'number', half: true, placeholder: t('5000') },\n  { key: 'exclusive_to', label: t('獨佔通路'), half: true, placeholder: t('例：Target') },\n  { key: 'price', label: t('售價'), type: 'number', half: true, placeholder: t('34.99') },\n  { key: 'currency', label: t('幣別'), half: true, placeholder: t('USD') },\n  { key: 'format', label: t('規格'), half: true, placeholder: t('例：12\" Vinyl') },\n  { key: 'catalog_no', label: t('廠牌編號'), half: true, placeholder: t('例：XLLP324') },\n  { key: 'buy_url', label: t('購買連結'), placeholder: t('https://…') },\n  { key: 'notes', label: t('備註'), type: 'textarea' },\n  { key: 'is_limited', label: t('Limited 限量'), type: 'check' },\n  { key: 'is_exclusive', label: t('Exclusive 獨佔'), type: 'check' },\n  { key: 'want', label: t('❤ Want 想要'), type: 'check' },\n  { key: 'owned', label: t('✓ Owned 已擁有'), type: 'check' },\n];\n\n/* ========================================================================== */\n/* 路由                                                                        */\n/* ========================================================================== */\nfunction parseRoute() {\n  const h = location.hash.replace(/^#\\/?/, '');\n  const [name, id] = h.split('/');\n  if (name === 'artist' && id) return { view: 'artist', id: Number(id) };\n  if (name === 'album' && id)  return { view: 'album', id: Number(id) };\n  if (name === 'collection')   return { view: 'collection' };\n  return { view: 'home' };\n}\n\nlet state = { filter: 'all', region: '', q: '' };\n\nasync function render() {\n  const route = parseRoute();\n  fab.hidden = true;\n  refreshStats();\n  try {\n    if (route.view === 'artist')          await viewArtist(route.id);\n    else if (route.view === 'album')      await viewAlbum(route.id);\n    else if (route.view === 'collection') await viewCollection();\n    else                                  await viewHome();\n  } catch (err) {\n    app.innerHTML = errorState(err);\n  }\n  bind();\n}\n\nasync function refreshStats() {\n  const el = $('#stats');\n  try {\n    const s = await API.stats();\n    el.innerHTML =\n      '<span>' + t('歌手') + ' <b>' + s.artists + '</b></span>' +\n      '<span>' + t('專輯') + ' <b>' + s.albums + '</b></span>' +\n      '<span>' + t('版本') + ' <b>' + s.versions + '</b></span>' +\n      '<span>❤ <b>' + s.want + '</b></span>' +\n      '<span>✓ <b>' + s.owned + '</b></span>';\n    el.hidden = false;\n  } catch { el.hidden = true; }\n}\n\n/* ---------- 首頁：歌手列表 + 線上即時搜尋 ---------- */\nlet onlineSeq = 0;\n\nconst artistGridHtml = (artists) =>\n  '<div class=\"grid artists\">' + artists.map((a) =>\n    '<div class=\"card artist-card\">' +\n      '<button style=\"all:unset;cursor:pointer;display:block\" data-go=\"#/artist/' + a.id + '\">' +\n        coverHtml(a.image_url) + '</button>' +\n      '<div class=\"body\">' +\n        '<h3><button style=\"all:unset;cursor:pointer\" data-go=\"#/artist/' + a.id + '\">' + esc(a.name) + '</button></h3>' +\n        (a.country ? '<div class=\"meta\">' + esc(a.country) + '</div>' : '') +\n        '<div class=\"count-row\"><span><b>' + a.album_count + '</b> ' + t('專輯') + '</span>' +\n          '<span><b>' + a.version_count + '</b> ' + t('版本') + '</span>' +\n          '<span><b>' + a.owned_count + '</b> ' + t('已收') + '</span></div>' +\n        '<div class=\"actions\"><div class=\"card-menu\">' +\n          '<button class=\"mini\" data-edit-artist=\\'' + attr(JSON.stringify(a)) + '\\' title=\"' + attr(t('編輯')) + '\">✎</button>' +\n          '<button class=\"mini del\" data-del-artist=\"' + a.id + '\" data-name=\"' + attr(a.name) + '\" title=\"' + attr(t('刪除')) + '\">🗑</button>' +\n        '</div></div>' +\n      '</div>' +\n    '</div>').join('') + '</div>';\n\nasync function viewHome() {\n  app.innerHTML = crumbs([{ label: t('歌手') }]) +\n    pageHead('Collection', t('歌手'), t('打幾個字就直接查線上資料庫，選一位就把他所有黑膠抓進來'),\n      '<button class=\"btn\" data-go=\"#/collection\">' + t('我的收藏') + '</button>' +\n      '<button class=\"btn\" data-new-artist>' + t('+ 手動新增') + '</button>') +\n    '<div class=\"toolbar\"><div class=\"search\">' +\n      '<input id=\"q\" placeholder=\"' + attr(t('輸入歌手名字，打幾個字就好…')) + '\" value=\"' + attr(state.q) + '\" autocomplete=\"off\"></div></div>' +\n    '<div id=\"list\">' + skeletons(6, 'artists') + '</div>' +\n    '<div id=\"online\"></div>';\n  bind();\n  fab.hidden = false;\n  fab.onclick = () => newArtist();\n  await refreshHome();\n}\n\n/** 只更新結果區，不重繪整頁 —— 輸入游標與注音組字才不會被打斷。 */\nasync function refreshHome() {\n  const list = $('#list');\n  if (!list) return;\n  const artists = await API.artists(state.q);\n  if (!$('#list')) return;\n\n  $('#list').innerHTML = artists.length\n    ? (state.q ? '<div class=\"sec-h\">' + t('我的收藏') + '</div>' : '') + artistGridHtml(artists)\n    : (state.q ? '' : emptyState(t('收藏庫還是空的'),\n        t('在上面打一位歌手的名字 —— 打幾個字就好。找到他之後，歷年來所有黑膠發行、年份、地區、廠牌、Side A / Side B 曲目都會自動抓進來。'),\n        '<button class=\"btn\" data-new-artist>' + t('+ 手動新增') + '</button>'));\n  bind();\n  searchOnline(state.q);\n}\n\n/** 邊打邊查線上資料庫；只渲染最後一次查詢的結果。 */\nfunction searchOnline(term) {\n  const seq = ++onlineSeq;\n  const slot = $('#online');\n  if (!slot) return;\n  if (!term) { slot.innerHTML = ''; return; }\n\n  const head = '<div class=\"sec-h\">' + t('線上資料庫') + '</div>';\n  const note = (t) => head + '<p style=\"color:var(--muted);font-size:13px;margin:0\">' + t + '</p>';\n  slot.innerHTML = note(esc(t('搜尋「{0}」…', term)));\n\n  mbSearchArtists(term, { prefix: true, limit: 10 }).then((list) => {\n    const el = $('#online');\n    if (seq !== onlineSeq || !el) return;\n    if (!list.length) { el.innerHTML = note(esc(t('找不到符合「{0}」的歌手。', term))); return; }\n    el.innerHTML = '<div class=\"sec-h\">' + t('線上資料庫 · 點一下抓進來') + '</div>' +\n      '<div class=\"hits\">' + list.map((a) =>\n        '<button class=\"hit\" data-hit=\\'' + attr(JSON.stringify(a)) + '\\'>' +\n          '<span class=\"hit-disc\"></span>' +\n          '<span class=\"hit-main\">' +\n            '<span class=\"hit-name\">' + esc(a.name) + '</span>' +\n            '<span class=\"hit-meta\">' + esc([a.type, a.country, a.began, a.hint].filter(Boolean).join(' · ') || t('歌手')) + '</span>' +\n          '</span>' +\n          '<span class=\"hit-go\">' + t('抓取 →') + '</span>' +\n        '</button>').join('') + '</div>';\n    bind();\n  }).catch((e) => {\n    const el = $('#online');\n    if (seq !== onlineSeq || !el) return;\n    el.innerHTML = head + '<div class=\"err\"><b>' + t('查不到線上資料') + '</b><code>' + esc(e.message) + '</code></div>';\n  });\n}\n\n/* ---------- 歌手頁：專輯列表 ---------- */\nasync function viewArtist(id) {\n  app.innerHTML = skeletons(6, 'albums');\n  const [artist, albums] = await Promise.all([API.artist(id), API.albums(id)]);\n\n  app.innerHTML = crumbs([{ label: t('歌手'), hash: '#/' }, { label: artist.name }]) +\n    pageHead(artist.country || 'Artist', artist.name,\n      t('{0} 張專輯', albums.length),\n      '<button class=\"btn\" data-edit-artist=\\'' + attr(JSON.stringify(artist)) + '\\'>' + t('編輯歌手') + '</button>' +\n      '<button class=\"btn primary\" data-new-album=\"' + artist.id + '\">+ ' + t('新增專輯') + '</button>') +\n    (albums.length\n      ? '<div class=\"grid albums\">' + albums.map((al) =>\n          '<div class=\"card\">' +\n            '<button style=\"all:unset;cursor:pointer;display:block\" data-go=\"#/album/' + al.id + '\">' +\n              coverHtml(al.cover_url) + '</button>' +\n            '<div class=\"body\">' +\n              '<h3><button style=\"all:unset;cursor:pointer\" data-go=\"#/album/' + al.id + '\">' + esc(al.title) + '</button></h3>' +\n              '<div class=\"meta\">' + esc([al.release_year, al.label].filter(Boolean).join(' · ')) + '</div>' +\n              '<div class=\"count-row\"><span><b>' + al.version_count + '</b> ' + t('版本') + '</span>' +\n                '<span><b>' + al.owned_count + '</b> ' + t('已收') + '</span><span><b>' + al.want_count + '</b> ' + t('想要') + '</span></div>' +\n              '<div class=\"actions\"><div class=\"card-menu\">' +\n                '<button class=\"mini\" data-edit-album=\\'' + attr(JSON.stringify(al)) + '\\' title=\"' + attr(t('編輯')) + '\">✎</button>' +\n                '<button class=\"mini del\" data-del-album=\"' + al.id + '\" data-name=\"' + attr(al.title) + '\" title=\"' + attr(t('刪除')) + '\">🗑</button>' +\n              '</div></div>' +\n            '</div>' +\n          '</div>').join('') + '</div>'\n      : emptyState(t('還沒有專輯'), t('幫 {0} 加入第一張專輯。', artist.name),\n          '<button class=\"btn primary\" data-new-album=\"' + artist.id + '\">+ ' + t('新增專輯') + '</button>'));\n\n  fab.hidden = false;\n  fab.onclick = () => newAlbum(artist.id);\n}\n\n/* ---------- 專輯頁：版本卡片牆 ---------- */\nasync function viewAlbum(id) {\n  app.innerHTML = skeletons(6, 'versions');\n  const [album, versions] = await Promise.all([API.album(id), API.versions('album_id=' + id)]);\n  renderVersionPage({\n    album,\n    versions,\n    crumbItems: [\n      { label: t('歌手'), hash: '#/' },\n      { label: album.artist_name, hash: '#/artist/' + album.artist_id },\n      { label: album.title },\n    ],\n    eyebrow: album.artist_name,\n    title: album.title,\n    sub: [album.release_year, album.label].filter(Boolean).join(' · '),\n    actions:\n      '<button class=\"btn\" data-edit-album=\\'' + attr(JSON.stringify(album)) + '\\'>' + t('編輯專輯') + '</button>' +\n      '<button class=\"btn primary\" data-new-version=\"' + album.id + '\">+ ' + t('新增版本') + '</button>',\n    onEmptyBtn: '<button class=\"btn primary\" data-new-version=\"' + album.id + '\">+ ' + t('新增版本') + '</button>',\n    fabAction: () => newVersion(album.id),\n  });\n}\n\n/* ---------- 全站收藏（跨專輯） ---------- */\nasync function viewCollection() {\n  app.innerHTML = skeletons(8, 'versions');\n  const versions = await API.versions('');\n  renderVersionPage({\n    versions,\n    crumbItems: [{ label: t('歌手'), hash: '#/' }, { label: t('我的收藏') }],\n    eyebrow: 'Collection',\n    title: t('所有版本'),\n    sub: t('{0} 個版本', versions.length),\n    actions: '',\n    showAlbumName: true,\n    onEmptyBtn: '<button class=\"btn primary\" data-go=\"#/\">' + t('回歌手列表') + '</button>',\n  });\n}\n\nfunction renderVersionPage(opts) {\n  const { versions, crumbItems, eyebrow, title, sub, actions, onEmptyBtn, showAlbumName, fabAction } = opts;\n\n  const regions = [...new Set(versions.map((v) => v.region).filter(Boolean))].sort();\n  const filtered = versions.filter((v) => {\n    if (state.filter === 'want' && !v.want) return false;\n    if (state.filter === 'owned' && !v.owned) return false;\n    if (state.filter === 'limited' && !v.is_limited) return false;\n    if (state.region && v.region !== state.region) return false;\n    return true;\n  });\n\n  const chip = (key, label) =>\n    '<button class=\"chip' + (state.filter === key ? ' on' : '') + '\" data-filter=\"' + key + '\">' + label + '</button>';\n\n  app.innerHTML = crumbs(crumbItems) +\n    pageHead(eyebrow, title, sub, actions) +\n    (versions.length ? '<div class=\"toolbar\">' +\n      '<div class=\"chips\">' + chip('all', t('全部')) + chip('want', '❤ Want') +\n        chip('owned', '✓ Owned') + chip('limited', t('限量')) + '</div>' +\n      (regions.length > 1\n        ? '<select id=\"regionSel\" style=\"width:auto;min-width:140px\"><option value=\"\">' + t('所有地區') + '</option>' +\n          regions.map((r) => '<option value=\"' + attr(r) + '\"' + (state.region === r ? ' selected' : '') + '>' + esc(r) + '</option>').join('') +\n          '</select>'\n        : '') +\n      '<span style=\"color:var(--muted);font-size:12.5px;margin-left:auto\">' + filtered.length + ' / ' + versions.length + '</span>' +\n    '</div>' : '') +\n    (filtered.length\n      ? '<div class=\"grid versions\">' + filtered.map((v) => versionCard(v, showAlbumName)).join('') + '</div>'\n      : emptyState(\n          versions.length ? t('沒有符合篩選的版本') : t('還沒有任何版本'),\n          versions.length ? t('換個篩選條件看看。') : t('加入第一個版本：顏色、限量、地區、售價都可以記錄。'),\n          versions.length ? '<button class=\"chip\" data-filter=\"all\">' + t('清除篩選') + '</button>' : onEmptyBtn));\n\n  if (fabAction) { fab.hidden = false; fab.onclick = fabAction; }\n}\n\nfunction versionCard(v, showAlbumName) {\n  const badges =\n    (v.is_limited ? '<span class=\"badge limited\">Limited</span>' : '') +\n    (v.is_exclusive ? '<span class=\"badge excl\">' + esc(v.exclusive_to || 'Exclusive') + '</span>' : '') +\n    (v.region ? '<span class=\"badge\">' + esc(v.region) + '</span>' : '');\n  const swatch = v.color_hex\n    ? '<span class=\"swatch\" style=\"background:' + attr(/^#[0-9a-f]{3,8}$/i.test(v.color_hex) ? v.color_hex : '#C9A24B') + '\" title=\"' + attr(v.color || '') + '\"></span>'\n    : '';\n  const cover = coverHtml(v.cover_url || v.album_cover_url, '<div class=\"badges\">' + badges + '</div>' + swatch);\n  const buy = safeUrl(v.buy_url);\n\n  const rows = [\n    showAlbumName && v.album_title ? [t('專輯'), v.artist_name + ' · ' + v.album_title] : null,\n    v.color ? [t('顏色'), v.color] : null,\n    v.format ? [t('規格'), v.format] : null,\n    v.release_date ? [t('發行'), v.release_date] : null,\n    v.catalog_no ? [t('編號'), v.catalog_no] : null,\n    v.edition_size ? [t('限量'), Number(v.edition_size).toLocaleString() + (LANG === 'en' ? '' : ' 張')] : null,\n  ].filter(Boolean);\n\n  return '<div class=\"card vcard\">' + cover +\n    '<div class=\"body\">' +\n      '<h3>' + esc(v.name) + '</h3>' +\n      (rows.length ? '<div class=\"rows\">' + rows.map((r) =>\n        '<div><span>' + esc(r[0]) + '</span><span>' + esc(r[1]) + '</span></div>').join('') + '</div>' : '') +\n      (v.price != null ? '<div class=\"price\" style=\"margin-top:8px\">' + esc(money(v.price, v.currency)) + '</div>' : '') +\n      (v.notes ? '<div class=\"meta\" style=\"margin-top:6px\">' + esc(v.notes) + '</div>' : '') +\n      '<div class=\"actions\">' +\n        '<button class=\"toggle want' + (v.want ? ' on' : '') + '\" data-toggle=\"want\" data-id=\"' + v.id + '\" data-val=\"' + (v.want ? 0 : 1) + '\">❤ Want</button>' +\n        '<button class=\"toggle owned' + (v.owned ? ' on' : '') + '\" data-toggle=\"owned\" data-id=\"' + v.id + '\" data-val=\"' + (v.owned ? 0 : 1) + '\">✓ Owned</button>' +\n        '<div class=\"card-menu\">' +\n          ((v.tracks_loaded || v.mb_id) ? '<button class=\"mini\" data-tracks=\\'' + attr(JSON.stringify(v)) + '\\' title=\"' + attr(t('曲目')) + '\">♪</button>' : '') +\n          (buy ? '<a class=\"mini\" href=\"' + attr(buy) + '\" target=\"_blank\" rel=\"noopener noreferrer\" title=\"' + attr(t('購買')) + '\">🛒</a>' : '') +\n          '<button class=\"mini\" data-edit-version=\\'' + attr(JSON.stringify(v)) + '\\' title=\"' + attr(t('編輯')) + '\">✎</button>' +\n          '<button class=\"mini del\" data-del-version=\"' + v.id + '\" data-name=\"' + attr(v.name) + '\" title=\"' + attr(t('刪除')) + '\">🗑</button>' +\n        '</div>' +\n      '</div>' +\n    '</div>' +\n  '</div>';\n}\n\n/* ========================================================================== */\n/* 從 MusicBrainz 匯入                                                         */\n/* ========================================================================== */\nfunction openImport(opts) {\n  const { query: initialQuery, artist: directArtist } = opts || {};\n  const m = openModal(\n    '<h3>' + t('從資料庫匯入') + '</h3>' +\n    '<p class=\"hint\">' + t('輸入歌手名字，自動抓出他歷年來所有黑膠發行 —— 發行年份、地區、廠牌、曲目全都有。資料來自 MusicBrainz（免費的公開音樂資料庫）。') + '</p>' +\n    '<label class=\"fld\"><span>' + t('歌手名稱') + '</span>' +\n      '<input id=\"mbQ\" placeholder=\"' + attr(t('例：Radiohead、周杰倫、Taylor Swift')) + '\" autocomplete=\"off\"></label>' +\n    '<div id=\"mbBody\"></div>' +\n    '<div class=\"modal-foot\"><button class=\"btn ghost\" data-close>' + t('關閉') + '</button>' +\n    '<button class=\"btn primary\" id=\"mbGo\">' + t('搜尋') + '</button></div>');\n\n  const q = m.el.querySelector('#mbQ');\n  const body = m.el.querySelector('#mbBody');\n  const goBtn = m.el.querySelector('#mbGo');\n  m.el.querySelector('[data-close]').onclick = m.close;\n\n  const busy = (t) => { body.innerHTML = '<p class=\"hint\" style=\"text-align:center;padding:18px 0\">' + esc(t) + '</p>'; };\n  const fail = (e) => { body.innerHTML = '<div class=\"err\"><b>' + t('出錯了') + '</b><code>' + esc(e.message) + '</code></div>'; };\n\n  /* --- 步驟 1：搜尋歌手 --- */\n  const search = async () => {\n    const name = q.value.trim();\n    if (!name) { q.focus(); return; }\n    busy(t('搜尋中…'));\n    try {\n      const list = await mbSearchArtists(name);\n      if (!list.length) { body.innerHTML = '<p class=\"hint\">' + esc(t('找不到「{0}」，換個寫法試試（例如用英文原名）。', name)) + '</p>'; return; }\n      body.innerHTML = '<p class=\"hint\" style=\"margin:6px 0 10px\">' + t('選一位：') + '</p>' +\n        '<div style=\"display:flex;flex-direction:column;gap:8px\">' +\n        list.map((a, i) =>\n          '<button class=\"btn\" data-pick=\"' + i + '\" style=\"justify-content:flex-start;text-align:left;padding:11px 15px;border-radius:10px\">' +\n            '<span><b style=\"color:var(--cream)\">' + esc(a.name) + '</b>' +\n            '<span style=\"color:var(--muted);font-size:12.5px\">' +\n              [a.type, a.country, a.began, a.hint].filter(Boolean).map(esc).join(' · ') +\n            '</span></span>' +\n          '</button>').join('') + '</div>';\n      body.querySelectorAll('[data-pick]').forEach((el) => {\n        el.onclick = () => pickArtist(list[Number(el.dataset.pick)]);\n      });\n    } catch (e) { fail(e); }\n  };\n\n  /* --- 步驟 2：列出這位歌手的所有黑膠 --- */\n  const pickArtist = async (artist) => {\n    busy(t('正在抓 {0} 的黑膠發行…', artist.name));\n    try {\n      const releases = await mbVinylReleases(artist.mb_id,\n        (n) => busy(t('正在抓 {0} 的黑膠發行… 已找到 {1} 張', artist.name, n)));\n      if (!releases.length) {\n        body.innerHTML = '<p class=\"hint\">' + esc(t('MusicBrainz 上查不到 {0} 的黑膠發行。', artist.name)) + '</p>';\n        return;\n      }\n      const years = releases.map((r) => r.year).filter(Boolean);\n      body.innerHTML =\n        '<div style=\"border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:12px\">' +\n          '<b style=\"font-family:var(--serif);font-size:19px\">' + esc(artist.name) + '</b>' +\n          '<div class=\"hint\" style=\"margin:4px 0 0\">' + t('找到 {0} 張黑膠', '<b style=\"color:var(--gold)\">' + releases.length + '</b>') +\n          (years.length ? t('，年份 {0}–{1}', Math.min(...years), Math.max(...years)) : '') + '</div>' +\n        '</div>' +\n        '<div style=\"max-height:38vh;overflow-y:auto;border:1px solid var(--line);border-radius:10px;padding:8px 10px;margin-bottom:14px\">' +\n          releases.map((r) =>\n            '<div style=\"padding:7px 0;border-bottom:1px solid rgba(201,162,75,.1)\">' +\n              '<div style=\"font-size:13.5px\">' + esc(r.title) + '</div>' +\n              '<div style=\"color:var(--muted);font-size:11.5px\">' +\n                [r.year, r.country, r.format, r.label].filter(Boolean).map(esc).join(' · ') +\n              '</div></div>').join('') +\n        '</div>' +\n        '<label class=\"checks\" style=\"margin-bottom:14px\"><label style=\"display:flex;align-items:center;gap:8px;cursor:pointer\">' +\n          '<input type=\"checkbox\" id=\"mbTracks\" checked>' + t('同時抓取曲目（每張約 1 秒，{0} 張約 {1} 秒）', releases.length, Math.ceil(releases.length * 1.2)) + '</label></label>' +\n        '<button class=\"btn primary\" id=\"mbImport\" style=\"width:100%;justify-content:center\">' + t('全部匯入 {0} 張', releases.length) + '</button>' +\n        '<div id=\"mbProg\" class=\"hint\" style=\"margin-top:10px\"></div>';\n      body.querySelector('#mbImport').onclick = () =>\n        doImport(artist, releases, body.querySelector('#mbTracks').checked);\n    } catch (e) { fail(e); }\n  };\n\n  /* --- 步驟 3：寫進收藏庫 --- */\n  const doImport = async (artist, releases, withTracks) => {\n    const btn = body.querySelector('#mbImport');\n    const prog = body.querySelector('#mbProg');\n    btn.disabled = true;\n    const report = (t) => { prog.innerHTML = esc(t); };\n\n    try {\n      report(t('建立歌手…'));\n      const saved = await API.createArtist({\n        name: artist.name, country: artist.country, mb_id: artist.mb_id,\n        notes: t('從 MusicBrainz 匯入'),\n      });\n\n      // 以 release-group（＝專輯）分組，同一張專輯的不同壓片放在同一個專輯底下\n      const groups = new Map();\n      for (const r of releases) {\n        const key = r.group_id || r.group_title;\n        if (!groups.has(key)) groups.set(key, { title: r.group_title, year: r.year, mb_id: r.group_id, items: [] });\n        const g = groups.get(key);\n        if (r.year && (!g.year || r.year < g.year)) g.year = r.year;\n        g.items.push(r);\n      }\n\n      let done = 0;\n      const versionsToLoad = [];\n      for (const g of groups.values()) {\n        const album = await API.createAlbum({\n          artist_id: saved.id, title: g.title, release_year: g.year, mb_id: g.mb_id,\n          cover_url: g.items[0] ? caaCover(g.items[0].mb_id) : null,\n        });\n        for (const r of g.items) {\n          const v = await API.createVersion({\n            album_id: album.id,\n            name: [r.title !== g.title ? r.title : null, r.disambiguation, r.country, r.format]\n                    .filter(Boolean).join(' · ') || t('黑膠'),\n            cover_url: caaCover(r.mb_id),\n            region: r.country, release_date: r.date, format: r.format,\n            catalog_no: r.catalog_no, mb_id: r.mb_id,\n          });\n          if (r.label && !album.label) await API.updateAlbum(album.id, { label: r.label });\n          versionsToLoad.push({ versionId: v.id, mb_id: r.mb_id });\n          done++;\n          report(t('匯入中… {0} / {1}', done, releases.length));\n        }\n      }\n\n      if (withTracks) {\n        let n = 0;\n        for (const item of versionsToLoad) {\n          n++;\n          report(t('抓取曲目… {0} / {1}（可以先關掉，之後點版本也會自動抓）', n, versionsToLoad.length));\n          try {\n            const list = await mbTracks(item.mb_id);\n            if (list.length) await API.setTracks(item.versionId, list);\n          } catch { /* 單張失敗不影響其他張 */ }\n        }\n      }\n\n      m.close();\n      toast(t('已匯入 {0}：{1} 張專輯、{2} 個版本', artist.name, groups.size, releases.length));\n      go('#/artist/' + saved.id);\n      render();\n    } catch (e) {\n      btn.disabled = false;\n      fail(e);\n    }\n  };\n\n  goBtn.onclick = search;\n  q.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); search(); } };\n  if (directArtist) {\n    q.value = directArtist.name;\n    pickArtist(directArtist);\n  } else if (initialQuery) {\n    q.value = initialQuery;\n    search();\n  }\n}\n\n/* ========================================================================== */\n/* 曲目                                                                        */\n/* ========================================================================== */\nconst trackCache = new Map();\n\nasync function ensureTracks(v) {\n  if (trackCache.has(v.id)) return trackCache.get(v.id);\n  let list = await API.tracks(v.id);\n  if (!list.length && v.mb_id) {\n    const fetched = await mbTracks(v.mb_id);\n    if (fetched.length) list = await API.setTracks(v.id, fetched);\n  }\n  trackCache.set(v.id, list);\n  return list;\n}\n\nfunction tracklistHtml(list) {\n  if (!list.length) return '<p class=\"hint\" style=\"margin:0\">' + t('這個版本還沒有曲目資料。') + '</p>';\n  const sides = new Map();\n  for (const t of list) {\n    const key = t.side || '—';\n    if (!sides.has(key)) sides.set(key, []);\n    sides.get(key).push(t);\n  }\n  return [...sides.entries()].map(([side, items]) =>\n    '<div class=\"side\">' +\n      '<div class=\"side-h\">' + (side === '—' ? t('曲目') : 'Side ' + esc(side)) + '</div>' +\n      items.map((t) =>\n        '<div class=\"trk\">' +\n          '<span class=\"trk-n\">' + esc(t.number || '') + '</span>' +\n          '<span class=\"trk-t\">' + esc(t.title) + '</span>' +\n          '<span class=\"trk-d\">' + esc(mmss(t.length_ms)) + '</span>' +\n        '</div>').join('') +\n    '</div>').join('');\n}\n\nasync function openTracks(v) {\n  const m = openModal(\n    '<h3>' + esc(v.name) + '</h3>' +\n    '<p class=\"hint\">' + esc([v.album_title, v.region, v.release_date, v.format].filter(Boolean).join(' · ')) + '</p>' +\n    '<div id=\"tkBody\"><p class=\"hint\" style=\"text-align:center;padding:18px 0\">' + t('載入曲目…') + '</p></div>' +\n    '<div class=\"modal-foot\"><button class=\"btn ghost\" data-close>' + t('關閉') + '</button></div>');\n  m.el.querySelector('[data-close]').onclick = m.close;\n  try {\n    m.el.querySelector('#tkBody').innerHTML = tracklistHtml(await ensureTracks(v));\n  } catch (e) {\n    m.el.querySelector('#tkBody').innerHTML = '<div class=\"err\"><b>' + t('抓不到曲目') + '</b><code>' + esc(e.message) + '</code></div>';\n  }\n}\n\n/* ========================================================================== */\n/* 新增 / 編輯                                                                 */\n/* ========================================================================== */\nconst newArtist = () => formModal({\n  title: t('新增歌手'), hint: t('收藏庫的第一層'), fields: artistFields, submitLabel: t('新增'),\n  onSubmit: async (d) => { await API.createArtist(d); toast(t('已新增歌手')); render(); },\n});\n\nconst editArtist = (a) => formModal({\n  title: t('編輯歌手'), fields: artistFields, values: a, submitLabel: t('儲存'),\n  onSubmit: async (d) => { await API.updateArtist(a.id, d); toast(t('已更新')); render(); },\n});\n\nconst newAlbum = (artistId) => formModal({\n  title: t('新增專輯'), fields: albumFields, submitLabel: t('新增'),\n  onSubmit: async (d) => { await API.createAlbum({ ...d, artist_id: artistId }); toast(t('已新增專輯')); render(); },\n});\n\nconst editAlbum = (al) => formModal({\n  title: t('編輯專輯'), fields: albumFields, values: al, submitLabel: t('儲存'),\n  onSubmit: async (d) => { await API.updateAlbum(al.id, d); toast('已更新'); render(); },\n});\n\nconst newVersion = (albumId) => formModal({\n  title: t('新增版本'), hint: t('顏色、限量、地區、售價、購買連結'), fields: versionFields,\n  values: { currency: 'USD', color_hex: '#C9A24B' }, submitLabel: t('新增'),\n  onSubmit: async (d) => { await API.createVersion({ ...d, album_id: albumId }); toast(t('已新增版本')); render(); },\n});\n\nconst editVersion = (v) => formModal({\n  title: t('編輯版本'), fields: versionFields, values: v, submitLabel: t('儲存'),\n  onSubmit: async (d) => { await API.updateVersion(v.id, d); toast('已更新'); render(); },\n});\n\n/* ========================================================================== */\n/* 事件綁定                                                                    */\n/* ========================================================================== */\nfunction bind() {\n  document.querySelectorAll('[data-go]').forEach((el) => {\n    el.onclick = (e) => { e.preventDefault(); go(el.dataset.go); };\n  });\n  document.querySelectorAll('[data-settings]').forEach((el) => { el.onclick = openSettings; });\n  document.querySelectorAll('[data-retry]').forEach((el) => { el.onclick = render; });\n  document.querySelectorAll('[data-hit]').forEach((el) => {\n    el.onclick = () => openImport({ artist: JSON.parse(el.dataset.hit) });\n  });\n  document.querySelectorAll('[data-tracks]').forEach((el) => {\n    el.onclick = () => openTracks(JSON.parse(el.dataset.tracks));\n  });\n  document.querySelectorAll('[data-setup]').forEach((el) => { el.onclick = () => runSetup(false); });\n  document.querySelectorAll('[data-setup-seed]').forEach((el) => { el.onclick = () => runSetup(true); });\n\n  document.querySelectorAll('[data-new-artist]').forEach((el) => { el.onclick = () => newArtist(); });\n  document.querySelectorAll('[data-new-album]').forEach((el) => { el.onclick = () => newAlbum(Number(el.dataset.newAlbum)); });\n  document.querySelectorAll('[data-new-version]').forEach((el) => { el.onclick = () => newVersion(Number(el.dataset.newVersion)); });\n\n  document.querySelectorAll('[data-edit-artist]').forEach((el) => { el.onclick = () => editArtist(JSON.parse(el.dataset.editArtist)); });\n  document.querySelectorAll('[data-edit-album]').forEach((el) => { el.onclick = () => editAlbum(JSON.parse(el.dataset.editAlbum)); });\n  document.querySelectorAll('[data-edit-version]').forEach((el) => { el.onclick = () => editVersion(JSON.parse(el.dataset.editVersion)); });\n\n  document.querySelectorAll('[data-del-artist]').forEach((el) => {\n    el.onclick = () => confirmModal(t('刪除「{0}」會同時刪掉底下所有專輯與版本，確定嗎？', el.dataset.name),\n      async () => { await API.deleteArtist(el.dataset.delArtist); toast(t('已刪除')); go('#/'); render(); });\n  });\n  document.querySelectorAll('[data-del-album]').forEach((el) => {\n    el.onclick = () => confirmModal(t('刪除「{0}」會同時刪掉底下所有版本，確定嗎？', el.dataset.name),\n      async () => { await API.deleteAlbum(el.dataset.delAlbum); toast('已刪除'); render(); });\n  });\n  document.querySelectorAll('[data-del-version]').forEach((el) => {\n    el.onclick = () => confirmModal(t('確定刪除版本「{0}」？', el.dataset.name),\n      async () => { await API.deleteVersion(el.dataset.delVersion); toast('已刪除'); render(); });\n  });\n\n  document.querySelectorAll('[data-toggle]').forEach((el) => {\n    el.onclick = async () => {\n      const field = el.dataset.toggle, val = Number(el.dataset.val), id = el.dataset.id;\n      el.disabled = true;\n      el.classList.toggle('on', val === 1);          // 樂觀更新\n      el.dataset.val = val === 1 ? 0 : 1;\n      try {\n        await API.updateVersion(id, { [field]: val });\n        toast(field === 'want' ? t(val ? '已加入想要' : '已移除想要') : t(val ? '已標記擁有' : '已取消擁有'));\n        refreshStats();\n      } catch (err) {\n        el.classList.toggle('on', val !== 1);        // 回滾\n        el.dataset.val = val;\n        toast(err.message, true);\n      } finally { el.disabled = false; }\n    };\n  });\n\n  document.querySelectorAll('[data-filter]').forEach((el) => {\n    el.onclick = () => { state.filter = el.dataset.filter; if (state.filter === 'all') state.region = ''; render(); };\n  });\n\n  const regionSel = $('#regionSel');\n  if (regionSel) regionSel.onchange = () => { state.region = regionSel.value; render(); };\n\n  const q = $('#q');\n  if (q && !q.dataset.bound) {\n    q.dataset.bound = '1';\n    let t;\n    q.oninput = () => {\n      clearTimeout(t);\n      t = setTimeout(() => { state.q = q.value.trim(); refreshHome(); }, 380);\n    };\n    if (state.q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }\n  }\n}\n\n/* ========================================================================== */\nwindow.addEventListener('hashchange', () => { state.filter = 'all'; state.region = ''; render(); });\nrender();\n})();\n</script>\n</body>\n</html>\n";

const manifest = "{\n  \"name\": \"VinylVault\",\n  \"short_name\": \"VinylVault\",\n  \"description\": \"黑膠唱片版本收藏管理 — 歌手 · 專輯 · 版本\",\n  \"start_url\": \"./index.html\",\n  \"scope\": \"./\",\n  \"display\": \"standalone\",\n  \"orientation\": \"portrait\",\n  \"background_color\": \"#0C0A07\",\n  \"theme_color\": \"#0C0A07\",\n  \"lang\": \"zh-Hant\",\n  \"icons\": [\n    { \"src\": \"assets/icon.svg\", \"sizes\": \"any\", \"type\": \"image/svg+xml\", \"purpose\": \"any\" },\n    { \"src\": \"assets/icon-192.png\", \"sizes\": \"192x192\", \"type\": \"image/png\" },\n    { \"src\": \"assets/icon-512.png\", \"sizes\": \"512x512\", \"type\": \"image/png\" },\n    { \"src\": \"assets/icon-1024.png\", \"sizes\": \"1024x1024\", \"type\": \"image/png\", \"purpose\": \"any\" }\n  ]\n}\n";

export default createWorker({ html, manifest });
