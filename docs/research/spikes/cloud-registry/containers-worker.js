// The fan-out surface. A Workflow (or a human with curl) asks for N agents; each
// is a container that runs one fuzz round and exits. Nothing is long-lived: the
// clock is the Workflow, the state is the registry, the container is disposable.
import { Container, getContainer } from '@cloudflare/containers';

export class FuzzAgent extends Container {
  defaultPort = 0;              // no inbound service; this is a batch job
  sleepAfter = '30m';           // a round is ~5 min; this is the runaway guard
  envVars = {
    FUZZ_REGISTRY_URL: this.env?.REGISTRY_URL,
    FUZZ_REGISTRY_TOKEN: this.env?.REGISTRY_TOKEN,
  };
  onStop({ exitCode }) {
    // exit 1 means "found something", which is success, not failure.
    console.log(JSON.stringify({ event: 'round-done', agent: this.ctx?.id?.toString(), exitCode }));
  }
  onError(err) { console.log(JSON.stringify({ event: 'agent-error', error: String(err) })); }
}

export async function fanOut(env, n, wave) {
  const started = [];
  for (let i = 0; i < n; i++) {
    const id = `${wave}-${i}`;
    const c = getContainer(env.FUZZ_AGENT, id);
    c.envVars = { ...c.envVars, FUZZ_AGENT_ID: id, FUZZ_WAVE: wave };
    await c.start();                       // returns once the container is running
    started.push(id);
  }
  return started;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/fan-out') {
      // Same shared-token check as worker.js: starting containers is billed.
      if (!env.REGISTRY_TOKEN || request.headers.get('authorization') !== `Bearer ${env.REGISTRY_TOKEN}`) {
        return new Response('unauthorized', { status: 401 });
      }
      // Cap it here, not in the caller: a typo in a cron expression must not be
      // able to start ten thousand containers.
      const n = Math.min(Number(url.searchParams.get('n') ?? 10), Number(env.MAX_AGENTS ?? 100));
      const ids = await fanOut(env, n, `manual-${Date.now()}`);
      return Response.json({ started: ids.length, ids });
    }
    return new Response('fuzz fan-out: GET /fan-out?n=10 (Bearer token required)', { status: 404 });
  },
};

export { FuzzLoop } from './fuzz-workflow.js';
