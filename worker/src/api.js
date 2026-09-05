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
  image_url: toStrOrNull, notes: toStrOrNull,
};

const ALBUM_FIELDS = {
  artist_id: toIntOrNull, title: toStrOrNull, release_year: toIntOrNull,
  cover_url: toStrOrNull, label: toStrOrNull, notes: toStrOrNull,
};

const VERSION_FIELDS = {
  album_id: toIntOrNull, name: toStrOrNull, cover_url: toStrOrNull,
  color: toStrOrNull, color_hex: toStrOrNull,
  is_limited: toBit, is_exclusive: toBit, exclusive_to: toStrOrNull,
  region: toStrOrNull, release_date: toStrOrNull, edition_size: toIntOrNull,
  price: toNumOrNull, currency: toStrOrNull, buy_url: toStrOrNull,
  want: toBit, owned: toBit, notes: toStrOrNull,
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
     created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
     updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_artists_name   ON artists(name)`,
  `CREATE INDEX IF NOT EXISTS idx_albums_artist         ON albums(artist_id)`,
  `CREATE INDEX IF NOT EXISTS idx_versions_album        ON versions(album_id)`,
  `CREATE INDEX IF NOT EXISTS idx_versions_want         ON versions(want)`,
  `CREATE INDEX IF NOT EXISTS idx_versions_owned        ON versions(owned)`,
  `CREATE INDEX IF NOT EXISTS idx_versions_region       ON versions(region)`,
];

async function runSetup(env, { seed = false } = {}) {
  for (const sql of SCHEMA_STATEMENTS) await query(env, sql);

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
  const [resource, rawId] = segments;
  const id = rawId != null ? toIntOrNull(rawId) : null;
  const p = url.searchParams;

  if (segments.length > 2) throw new HttpError(404, 'Not found');
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
          headers: { 'Content-Type': result.type, 'Cache-Control': 'no-cache' },
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

/** 純 API（不含前端檔案）—— 測試與本機開發伺服器用這個。 */
export default createWorker();
