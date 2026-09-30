// The registry contract, independent of which SQL engine runs it.
//
// claim() is the whole point: N stateless agents find the same defect, and
// EXACTLY ONE of them is told to file it. `hits = 1` is true only on the row's
// initial insert, so it is also retry-safe — an agent that repeats its own claim
// is told no, which is what you want when a container is restarted mid-flight.
export const CLAIM_SQL = `
  INSERT INTO findings (fingerprint, first_agent, first_seen, last_seen, hits, body)
  VALUES (?, ?, ?, ?, 1, ?)
  ON CONFLICT(fingerprint) DO UPDATE SET hits = hits + 1, last_seen = excluded.last_seen
  RETURNING first_agent, hits, (hits = 1) AS claimed`;

export const BEAT_SQL = `
  INSERT INTO beats (agent, at, round, journeys, exit_code) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(agent) DO UPDATE SET at = excluded.at, round = excluded.round,
    journeys = excluded.journeys, exit_code = excluded.exit_code`;

export const UNTRIAGED_SQL =
  `SELECT fingerprint, first_agent, first_seen, hits, body FROM findings
   WHERE triaged_at IS NULL ORDER BY first_seen LIMIT ?`;

export const TRIAGED_SQL = `UPDATE findings SET triaged_at = ? WHERE fingerprint = ? AND triaged_at IS NULL`;

/** Rows -> the one screen a human should have to look at. */
export function pulse(beats, counts, now = Date.now()) {
  const STALE_MS = 15 * 60 * 1000;
  const lanes = beats.map(b => ({
    agent: b.agent, at: b.at, round: b.round,
    stale: now - Date.parse(b.at) > STALE_MS,
  }));
  return {
    lanes: lanes.length,
    alive: lanes.filter(l => !l.stale).length,
    stale: lanes.filter(l => l.stale).map(l => l.agent),
    findings: counts.total,
    untriaged: counts.untriaged,
    // A loop whose lanes have all gone stale is the failure mode worth alarming on.
    healthy: lanes.length > 0 && lanes.some(l => !l.stale),
  };
}
