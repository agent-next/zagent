// The durable clock. This replaces the tmux session: it survives a laptop closing,
// a deploy, and a restart, because the instance state lives on Cloudflare and not
// in a shell. `step.sleep` is capped at 365 days and a step's wall time is
// unlimited, so a loop like this legitimately runs forever.
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { fanOut } from './containers-worker.js';

export class FuzzLoop extends WorkflowEntrypoint {
  async run(event, step) {
    const agents = event.payload?.agents ?? 10;
    let wave = 0;

    while (wave < (event.payload?.waves ?? 10000)) {
      wave++;
      const ids = await step.do(`wave ${wave}: start ${agents} agents`,
        { retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '15 minutes' },
        () => fanOut(this.env, agents, `w${wave}`));

      // Let the round finish before judging it. A round is ~5 min at 40 journeys.
      await step.sleep(`wave ${wave}: let the round run`, '10 minutes');

      const health = await step.do(`wave ${wave}: pulse`, async () => {
        const r = await fetch(new URL('/pulse', this.env.REGISTRY_URL), {
          headers: { authorization: `Bearer ${this.env.REGISTRY_TOKEN}` } });
        return r.json();
      });

      // The stop condition every recurring job must have. Silence is the failure
      // mode worth alarming on, so an unhealthy pulse ends the loop loudly rather
      // than burning credit on containers whose findings go nowhere.
      if (!health.healthy) {
        throw new Error(`wave ${wave}: registry reports no live lane — stopping (${JSON.stringify(health)})`);
      }
      await step.sleep(`wave ${wave}: pause`, event.payload?.every ?? '20 minutes');
    }
    return { waves: wave };
  }
}
