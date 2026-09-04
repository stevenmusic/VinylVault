import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockTurso } from './turso-mock.mjs';

globalThis.fetch = createMockTurso();
const worker = (await import('../src/index.js')).default;

const env = {
  TURSO_DATABASE_URL: 'libsql://mock.turso.io',
  TURSO_AUTH_TOKEN: 'mock-token',
};

async function call(method, path, body) {
  const res = await worker.fetch(new Request(`https://api.test${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json', Origin: 'https://example.com' } : { Origin: 'https://example.com' },
    body: body ? JSON.stringify(body) : undefined,
  }), env);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

test('health 回報資料庫可用', async () => {
  const r = await call('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), '*');
});

test('CRUD：artist -> album -> version', async () => {
  const a = await call('POST', '/artists', { name: 'Radiohead', country: 'UK' });
  assert.equal(a.status, 201);
  const artistId = a.body.id;

  const al = await call('POST', '/albums', { artist_id: artistId, title: 'In Rainbows', release_year: 2007 });
  assert.equal(al.status, 201);
  const albumId = al.body.id;

  const v = await call('POST', '/versions', {
    album_id: albumId, name: 'Gold Nugget LP', color: 'Gold', color_hex: '#C9A24B',
    is_limited: true, is_exclusive: 1, exclusive_to: 'Official Store',
    region: 'UK', release_date: '2007-12-31', edition_size: 1000,
    price: 42.5, currency: 'GBP', buy_url: 'https://example.com/buy', want: 1,
  });
  assert.equal(v.status, 201);
  assert.equal(v.body.is_limited, 1);
  assert.equal(v.body.price, 42.5);
  const versionId = v.body.id;

  const artists = await call('GET', '/artists');
  assert.equal(artists.body.length, 1);
  assert.equal(artists.body[0].album_count, 1);
  assert.equal(artists.body[0].version_count, 1);

  const albums = await call('GET', `/albums?artist_id=${artistId}`);
  assert.equal(albums.body[0].artist_name, 'Radiohead');
  assert.equal(albums.body[0].want_count, 1);

  const versions = await call('GET', `/versions?album_id=${albumId}`);
  assert.equal(versions.body[0].artist_name, 'Radiohead');
  assert.equal(versions.body[0].album_title, 'In Rainbows');

  // want / owned 切換
  const patched = await call('PATCH', `/versions/${versionId}`, { owned: 1, want: 0 });
  assert.equal(patched.body.owned, 1);
  assert.equal(patched.body.want, 0);

  // 篩選
  assert.equal((await call('GET', '/versions?owned=1')).body.length, 1);
  assert.equal((await call('GET', '/versions?want=1')).body.length, 0);
  assert.equal((await call('GET', '/versions?region=UK')).body.length, 1);
  assert.equal((await call('GET', '/versions?region=JP')).body.length, 0);
  assert.equal((await call('GET', `/versions?artist_id=${artistId}`)).body.length, 1);

  const stats = await call('GET', '/stats');
  assert.deepEqual(stats.body, { artists: 1, albums: 1, versions: 1, want: 0, owned: 1 });

  // 編輯
  const editedAlbum = await call('PATCH', `/albums/${albumId}`, { title: 'In Rainbows (Remaster)' });
  assert.equal(editedAlbum.body.title, 'In Rainbows (Remaster)');

  // 刪除 artist 會連動刪掉 album / version（ON DELETE CASCADE）
  assert.equal((await call('DELETE', `/artists/${artistId}`)).body.deleted, true);
  assert.equal((await call('GET', '/versions')).body.length, 0);
});

test('驗證與錯誤處理', async () => {
  assert.equal((await call('POST', '/artists', {})).status, 400);
  assert.equal((await call('POST', '/albums', { title: 'x' })).status, 400);
  assert.equal((await call('POST', '/versions', { name: 'x' })).status, 400);
  assert.equal((await call('GET', '/artists/999999')).status, 404);
  assert.equal((await call('PATCH', '/artists/999999', { name: 'x' })).status, 404);
  assert.equal((await call('GET', '/nope')).status, 404);
  assert.equal((await call('GET', '/artists/abc')).status, 400);
  assert.equal((await call('PATCH', '/artists/1', { bogus: 1 })).status, 400);
});

test('WRITE_TOKEN 會保護寫入端點', async () => {
  const guarded = { ...env, WRITE_TOKEN: 'secret123' };
  const req = (headers) => new Request('https://api.test/artists', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ name: 'Guarded' }),
  });
  assert.equal((await worker.fetch(req({}), guarded)).status, 401);
  assert.equal((await worker.fetch(req({ Authorization: 'Bearer secret123' }), guarded)).status, 201);
  // 讀取不需要 token
  assert.equal((await worker.fetch(new Request('https://api.test/artists'), guarded)).status, 200);
});

test('CORS preflight 與白名單', async () => {
  const res = await worker.fetch(
    new Request('https://api.test/artists', { method: 'OPTIONS', headers: { Origin: 'https://stevenmusic.github.io' } }),
    { ...env, ALLOWED_ORIGINS: 'https://stevenmusic.github.io,capacitor://localhost' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://stevenmusic.github.io');
});
