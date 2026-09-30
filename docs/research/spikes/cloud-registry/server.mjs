#!/usr/bin/env node
// The registry, locally: same HTTP contract and same SQL as the Cloudflare Worker,
// so the tmux loop and a 1000-container fan-out speak to one interface. Run it
// with no argument for an in-memory instance (tests), or --db <path> to persist.
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAIM_SQL, BEAT_SQL, UNTRIAGED_SQL, TRIAGED_SQL, pulse } from './registry-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };

const db = new DatabaseSync(arg('db', ':memory:'));
db.exec(readFileSync(path.join(here, 'schema.sql'), 'utf8'));

const json = (res, code, obj) => {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
  res.end(b);
};
const body = (req) => new Promise((resolve, reject) => {
  let s = ''; req.on('data', c => { s += c; if (s.length > 2e6) reject(new Error('too large')); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
});

export function handle(url, b) {
  const now = new Date().toISOString();
  if (url.pathname === '/claim') {
    if (!b.fingerprint || !b.agent) return [400, { error: 'fingerprint and agent required' }];
    const r = db.prepare(CLAIM_SQL).get(b.fingerprint, b.agent, now, now, b.body ? JSON.stringify(b.body) : null);
    return [200, { fingerprint: b.fingerprint, claimed: r.claimed === 1, owner: r.first_agent, hits: r.hits }];
  }
  if (url.pathname === '/beat') {
    db.prepare(BEAT_SQL).run(b.agent, now, b.round ?? 0, b.journeys ?? 0, b.exit ?? null);
    return [200, { ok: true }];
  }
  if (url.pathname === '/untriaged') {
    const rows = db.prepare(UNTRIAGED_SQL).all(Number(url.searchParams.get('limit') ?? 20));
    return [200, { findings: rows.map(r => ({ ...r, body: r.body ? JSON.parse(r.body) : null })) }];
  }
  if (url.pathname === '/triaged') {
    const r = db.prepare(TRIAGED_SQL).run(now, b.fingerprint);
    return [200, { updated: Number(r.changes) }];
  }
  if (url.pathname === '/pulse') {
    const beats = db.prepare('SELECT agent, at, round FROM beats').all();
    const total = db.prepare('SELECT COUNT(*) AS n FROM findings').get().n;
    const untriaged = db.prepare('SELECT COUNT(*) AS n FROM findings WHERE triaged_at IS NULL').get().n;
    return [200, pulse(beats, { total, untriaged })];
  }
  return [404, { error: 'no such route' }];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(arg('port', 8787));
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const b = req.method === 'POST' ? await body(req) : {};
      const [code, out] = handle(url, b);
      json(res, code, out);
    } catch (e) { json(res, 400, { error: String(e.message || e) }); }
  }).listen(port, () => console.log(`fuzz-registry on :${port} (db=${arg('db', ':memory:')})`));
}
