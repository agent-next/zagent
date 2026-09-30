// What journey-fuzz.mjs uses instead of readdirSync(artifacts/fuzz).
//
// With FUZZ_REGISTRY_URL unset this is the behaviour the tmux loop already has —
// a local directory of fingerprints — so nothing changes for a single lane. With
// it set, "have I seen this?" becomes "did I win the claim?", which is the only
// question that has a correct answer when N containers share no disk.
import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function registry({ url = process.env.FUZZ_REGISTRY_URL,
                           token = process.env.FUZZ_REGISTRY_TOKEN,
                           agent = process.env.FUZZ_AGENT_ID || `local-${process.pid}`,
                           dir } = {}) {
  const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const post = async (route, body) => {
    const r = await fetch(new URL(route, url), { method: 'POST', headers, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`registry ${route} -> ${r.status}`);
    return r.json();
  };

  if (!url) {
    // Local fallback: the directory IS the registry, exactly as today.
    return {
      mode: 'local', agent,
      async claim(fingerprint, body) {
        mkdirSync(dir, { recursive: true });
        const seen = new Set(readdirSync(dir).map(f => f.split('.')[0]));
        if (seen.has(fingerprint)) return { claimed: false, hits: 2, owner: agent };
        writeFileSync(path.join(dir, `${fingerprint}.json`), JSON.stringify(body ?? {}, null, 2));
        return { claimed: true, hits: 1, owner: agent };
      },
      async beat() { return { ok: true }; },
    };
  }
  return {
    mode: 'remote', agent,
    claim: (fingerprint, body) => post('/claim', { fingerprint, agent, body }),
    beat: (round, journeys, exit) => post('/beat', { agent, round, journeys, exit }),
  };
}
