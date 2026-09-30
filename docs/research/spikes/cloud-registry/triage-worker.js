// The close-the-loop leg, in the cloud: claimed findings -> a GitHub issue a human
// can act on. It mirrors the original shell triage script, with three differences that
// only matter once there are many agents:
//
//   * it reads the shared registry, not a local directory;
//   * it marks the finding triaged, so a second worker cannot double-file;
//   * it sends `x-opencode-session`, which the opencode Go endpoint began REQUIRING — without
//     it every request is 400 MissingSessionID, tools or not (measured 2026-09-07).
//
// A finding is screen text plus a keystroke script from the published artifact: no
// credential and no private source, which is why a bulk free model tier is allowed here.
const BULK = ['deepseek-v4-flash', 'minimax-m3', 'qwen3.7-plus'];

// Hand the model the command instead of asking it to find one. The shell script asks
// for `--seed <seed>` and the finding record carries no seed, so the model invents
// something ("reproduce d950776c54bd" in a 2026-09-07 probe) and every filed issue
// ends in a command that does not exist. The keystroke script is the only part of a
// finding that actually replays, so that is what ships.
function repro(f) {
  const b = f.body ?? {};
  const cmd = b.seed !== undefined && b.iteration !== undefined
    ? `node scripts/journey-fuzz.mjs --seed ${b.seed} --iterations ${b.iteration}`
    : 'node scripts/journey-fuzz.mjs --replay ' + f.fingerprint + '   # keystrokes below';
  return ['```', cmd, '```', '', 'Keystrokes: `' + JSON.stringify(b.script ?? []) + '`',
          'Terminal width: ' + (b.columns ?? '?') + ' columns'].join('\n');
}

async function writeUp(env, finding, model) {
  const r = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENCODE_KEY}`,
      'content-type': 'application/json',
      'x-opencode-session': `triage-${finding.fingerprint}`,
      'user-agent': 'zagent-triage/1.0',
    },
    body: JSON.stringify({
      model, max_tokens: 900,
      messages: [{ role: 'user', content:
`Write a GitHub issue for this reproducible TUI defect. An automated journey fuzzer
found it and CONFIRMED it by re-running, so do not hedge about whether it is real.

Rules: no speculation about causes you cannot see; quote the screen; under 250 words.
Do not invent file paths. End with EXACTLY this reproduction block, verbatim:

${repro(finding)}

FINDING JSON:
${JSON.stringify(finding.body, null, 2)}` }],
    }),
  });
  if (!r.ok) throw new Error(`model ${model} -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return d.choices?.[0]?.message?.content?.trim() || '';
}

async function fileIssue(env, title, body) {
  const r = await fetch(`https://api.github.com/repos/${env.ISSUE_REPO}/issues`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'zagent-triage',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels: ['fuzz', 'automated'] }),
  });
  if (!r.ok) throw new Error(`github -> ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).number;
}

async function triage(env, limit = 5) {
  const auth = { authorization: `Bearer ${env.REGISTRY_TOKEN}` };
  const { findings } = await (await fetch(new URL(`/untriaged?limit=${limit}`, env.REGISTRY_URL), { headers: auth })).json();
  const done = [];
  for (const f of findings) {
    const model = BULK[Math.floor(Math.random() * BULK.length)];
    try {
      const body = await writeUp(env, f, model);
      if (!body) { done.push({ fingerprint: f.fingerprint, skipped: 'model returned nothing' }); continue; }
      const ids = (f.body?.invariants ?? []).map(i => i.id).join(', ') || 'unknown';
      const n = await fileIssue(env, `TUI: ${ids} (${f.body?.spec?.behaviour ?? 'ok'})`,
        `${body}\n\n---\nfingerprint \`${f.fingerprint}\` · first seen by \`${f.first_agent}\` · rediscovered ${f.hits}×`);
      // Mark only AFTER the issue exists: a crash in between must re-file, never drop.
      await fetch(new URL('/triaged', env.REGISTRY_URL), {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ fingerprint: f.fingerprint }),
      });
      done.push({ fingerprint: f.fingerprint, issue: n, model });
    } catch (e) {
      done.push({ fingerprint: f.fingerprint, error: String(e.message || e) });
    }
  }
  return done;
}

export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== '/triage') return new Response('POST /triage', { status: 404 });
    return Response.json(await triage(env));
  },
  async scheduled(_event, env, ctx) { ctx.waitUntil(triage(env)); },
};
export { triage, writeUp, fileIssue };
