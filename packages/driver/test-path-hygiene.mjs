// CP-5: pin the two cross-platform path invariants the audit relies on.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const d = mkdtempSync(path.join(os.tmpdir(), 'zhyg-'));
writeFileSync(path.join(d, 'f.txt'), 'x');
// (a) forward-slash fs access works regardless of platform separator
assert.equal(existsSync(`${d}/f.txt`), true, 'forward-slash access');
// (b) resolve equivalence: concat and join resolve identically
assert.equal(path.resolve(`${d}/f.txt`), path.resolve(path.join(d, 'f.txt')), 'resolve equivalence');
rmSync(d, { recursive: true, force: true });
console.log('PASS path-hygiene');
