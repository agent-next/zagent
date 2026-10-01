// AF_UNIX sun_path capacity, sized per platform, in one place: the relay's
// up-front refusal, the flock's socket-dir picker and the broker gate's
// fixtures all need the same answer. Linux gives sun_path 108 bytes; Darwin
// and the BSDs give it 104. A hardcoded 108 lets a 105-byte path pass every
// check on a 104-byte host — the bind then fails behind stdio:'ignore' and
// the caller learns nothing but a readiness timeout.
// `platform` is injectable so the gate can exercise both budgets on any host.

/** Max sun_path byte length for a platform ('darwin' by default is the host's). */
export function sunPathBudget(platform = process.platform) {
  return ['darwin', 'freebsd', 'openbsd', 'netbsd'].includes(platform) ? 104 : 108;
}

/** True when a unix-socket path fits the platform's sun_path budget. */
export function fitsSunPath(p, platform = process.platform) {
  return Buffer.byteLength(p) <= sunPathBudget(platform);
}
