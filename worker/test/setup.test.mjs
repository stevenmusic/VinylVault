import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockTurso } from './turso-mock.mjs';

// 空資料庫：完全沒有資料表，模擬使用者剛建好 Turso 的狀態
globalThis.fetch = createMockTurso({ schema: false });
const worker = (await import('../src/api.js')).default;

const env = { TURSO_DATABASE_URL: 'libsql://mock.turso.io', TURSO_AUTH_TOKEN: 'mock' };

const call = async (path, init = {}, e = env) => {
  const res = await worker.fetch(new Request('https://api.test' + path, init), e);
  return { status: res.status, body: await res.json() };
};

test('空資料庫讀取時會自動建表（不必手動開 /setup）', async () => {
  const r = await call('/artists');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);

  const tables = (await call('/setup')).body.tables;
  assert.deepEqual(tables.sort(), ['albums', 'artists', 'tracks', 'versions']);
});

test('/setup 會在空資料庫建好四張表', async () => {
  const r = await call('/setup');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.tables.sort(), ['albums', 'artists', 'tracks', 'versions']);
  assert.equal(r.body.seeded, false);

  const after = await call('/artists');
  assert.equal(after.status, 200);
  assert.deepEqual(after.body, []);
});

test('/setup 可以重複執行不會壞', async () => {
  const r = await call('/setup');
  assert.equal(r.body.ok, true);
  assert.deepEqual((await call('/artists')).body, []);
});

test('/setup?seed=1 加入範例資料，且只加一次', async () => {
  const r = await call('/setup?seed=1');
  assert.equal(r.body.seeded, true);

  const artists = (await call('/artists')).body;
  assert.equal(artists.length, 1);
  assert.equal(artists[0].name, 'Taylor Swift');
  assert.equal(artists[0].version_count, 2);

  const versions = (await call('/versions')).body;
  assert.equal(versions.length, 2);
  assert.equal(versions.filter((v) => v.want).length, 1);
  assert.equal(versions.filter((v) => v.owned).length, 1);
  assert.equal(versions.find((v) => v.name.includes('Jade')).is_limited, 1);

  // 再跑一次不會重複塞
  const again = await call('/setup?seed=1');
  assert.equal(again.body.seeded, false);
  assert.equal((await call('/versions')).body.length, 2);
});

test('有設 WRITE_TOKEN 時 /setup 需要驗證', async () => {
  const guarded = { ...env, WRITE_TOKEN: 'secret123' };
  assert.equal((await call('/setup', {}, guarded)).status, 401);
  assert.equal((await call('/setup?token=wrong', {}, guarded)).status, 401);
  assert.equal((await call('/setup?token=secret123', {}, guarded)).status, 200);
  assert.equal((await call('/setup', { headers: { Authorization: 'Bearer secret123' } }, guarded)).status, 200);
});

test('自動建表後寫入也正常', async () => {
  // 用一個全新的空資料庫
  globalThis.fetch = createMockTurso({ schema: false });
  const w = (await import('../src/api.js')).default;
  const post = await w.fetch(new Request('https://api.test/artists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Daft Punk', country: 'FR' }),
  }), env);
  assert.equal(post.status, 201);
  const list = await (await w.fetch(new Request('https://api.test/artists'), env)).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Daft Punk');
});
