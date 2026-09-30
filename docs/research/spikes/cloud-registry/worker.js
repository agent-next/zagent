// The same registry on Cloudflare: a Worker over D1. D1 serialises writes, so the
// single upsert in CLAIM_SQL is what makes "exactly one agent files it" hold across
// containers that never see each other.
import { CLAIM_SQL, BEAT_SQL, UNTRIAGED_SQL, TRIAGED_SQL, pulse } from './registry-core.mjs';

const json = (o, code = 200) => new Response(JSON.stringify(o), {
  status: code, headers: { 'content-type': 'application/json' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // A shared token, not a user account: these agents are ours, the payload is
    // public-artifact screen text, and the only write is "I saw this defect".
    if (env.REGISTRY_TOKEN && request.headers.get('authorization') !== `Bearer ${env.REGISTRY_TOKEN}`) {
      return json({ error: 'unauthorized' }, 401);
    }
    const b = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const now = new Date().toISOString();

    if (url.pathname === '/claim') {
      if (!b.fingerprint || !b.agent) return json({ error: 'fingerprint and agent required' }, 400);
      const r = await env.DB.prepare(CLAIM_SQL)
        .bind(b.fingerprint, b.agent, now, now, b.body ? JSON.stringify(b.body) : null).first();
      return json({ fingerprint: b.fingerprint, claimed: r.claimed === 1, owner: r.first_agent, hits: r.hits });
    }
    if (url.pathname === '/beat') {
      await env.DB.prepare(BEAT_SQL).bind(b.agent, now, b.round ?? 0, b.journeys ?? 0, b.exit ?? null).run();
      return json({ ok: true });
    }
    if (url.pathname === '/untriaged') {
      const { results } = await env.DB.prepare(UNTRIAGED_SQL)
        .bind(Number(url.searchParams.get('limit') ?? 20)).all();
      return json({ findings: results.map(r => ({ ...r, body: r.body ? JSON.parse(r.body) : null })) });
    }
    if (url.pathname === '/triaged') {
      const r = await env.DB.prepare(TRIAGED_SQL).bind(now, b.fingerprint).run();
      return json({ updated: r.meta.changes });
    }
    if (url.pathname === '/pulse') {
      const beats = (await env.DB.prepare('SELECT agent, at, round FROM beats').all()).results;
      const total = (await env.DB.prepare('SELECT COUNT(*) AS n FROM findings').first()).n;
      const untriaged = (await env.DB.prepare('SELECT COUNT(*) AS n FROM findings WHERE triaged_at IS NULL').first()).n;
      return json(pulse(beats, { total, untriaged }));
    }
    return json({ error: 'no such route' }, 404);
  },
};
