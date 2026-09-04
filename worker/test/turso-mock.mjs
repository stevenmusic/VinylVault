/**
 * 測試用：以 node:sqlite 模擬 Turso 的 /v2/pipeline HTTP 介面，
 * 讓 Worker 的程式碼可以完全不改就在本機跑真實 SQL。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SCHEMA = fileURLToPath(new URL('../../db/schema.sql', import.meta.url));

export function createMockTurso() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA, 'utf8'));

  const toCell = (v) => {
    if (v === null || v === undefined) return { type: 'null' };
    if (typeof v === 'bigint') return { type: 'integer', value: String(v) };
    if (typeof v === 'number') {
      return Number.isInteger(v)
        ? { type: 'integer', value: String(v) }
        : { type: 'float', value: v };
    }
    return { type: 'text', value: String(v) };
  };

  const fromArg = (a) => {
    switch (a.type) {
      case 'null': return null;
      case 'integer': return BigInt(a.value);
      case 'float': return Number(a.value);
      default: return String(a.value);
    }
  };

  /** 取代 globalThis.fetch */
  return async function mockFetch(url, init = {}) {
    if (!String(url).includes('/v2/pipeline')) {
      throw new Error(`unexpected fetch to ${url}`);
    }
    const body = JSON.parse(init.body);
    const results = [];

    for (const req of body.requests) {
      if (req.type === 'close') { results.push({ type: 'ok', response: { type: 'close' } }); continue; }
      const { sql, args = [] } = req.stmt;
      try {
        const stmt = db.prepare(sql);
        const params = args.map(fromArg);
        const isRead = /^\s*(select|with|pragma)/i.test(sql);
        if (isRead) {
          const rows = stmt.all(...params);
          const cols = rows.length ? Object.keys(rows[0]) : [];
          results.push({
            type: 'ok',
            response: {
              type: 'execute',
              result: {
                cols: cols.map((name) => ({ name })),
                rows: rows.map((r) => cols.map((c) => toCell(r[c]))),
                affected_row_count: 0,
                last_insert_rowid: null,
              },
            },
          });
        } else {
          const info = stmt.run(...params);
          results.push({
            type: 'ok',
            response: {
              type: 'execute',
              result: {
                cols: [],
                rows: [],
                affected_row_count: Number(info.changes ?? 0),
                last_insert_rowid: String(info.lastInsertRowid ?? 0),
              },
            },
          });
        }
      } catch (e) {
        results.push({ type: 'error', error: { message: e.message } });
      }
    }

    return new Response(JSON.stringify({ baseUrl: null, results }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}
