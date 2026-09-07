// CP-2: platform-dispatched zip extraction. No Node-native unzip exists, and the `unzip`
// binary is Linux-typical only. Chain per platform (first hit wins, verified live for
// each executor):
//   win32:  tar -xf        (bsdtar ships with Windows 10 1803+)
//           powershell Expand-Archive (always present)
//   darwin: ditto -x -k    (native, zip-aware) → tar -xf (bsdtar) → unzip
//   linux:  unzip          (conventional) → tar -xf (bsdtar if installed)
// Each executor returns spawnSync-like { status } so installPlugin stays unchanged.
import { spawnSync } from 'node:child_process';

export const EXTRACTORS = {
  'tar': (zip, dir) => spawnSync('tar', ['-xf', zip, '-C', dir], { encoding: 'utf8' }),
  'unzip': (zip, dir) => spawnSync('unzip', ['-q', '-o', zip, '-d', dir], { encoding: 'utf8' }),
  'ditto': (zip, dir) => spawnSync('ditto', ['-x', '-k', zip, dir], { encoding: 'utf8' }),
  'powershell': (zip, dir) => spawnSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`],
    { encoding: 'utf8' }),
};

const PLATFORM_CHAIN = {
  win32: ['tar', 'powershell'],
  darwin: ['ditto', 'tar', 'unzip'],
  linux: ['unzip', 'tar'],
};

function available(name, platform) {
  if (name === 'tar') { // GNU tar cannot read zips; require bsdtar (libarchive) — checked on EVERY platform (r2)
    const v = spawnSync('tar', ['--version'], { encoding: 'utf8' });
    return v.status === 0 && /libarchive|bsdtar/i.test(v.stdout ?? '');
  }
  if (platform === 'win32') return name === 'powershell'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8' }).status === 0
    : spawnSync('where', [name], { encoding: 'utf8' }).status === 0;
  return spawnSync('which', [name], { encoding: 'utf8' }).status === 0;
}

export function extractorChain({ platform = process.platform, probe = available } = {}) {
  const chain = PLATFORM_CHAIN[platform] ?? PLATFORM_CHAIN.linux; // parens matter: ?? binds looser than .filter
  return chain.filter(name => probe(name, platform));
}

// The drop-in executor installPlugin consumes: first executor that exists and succeeds.
export function defaultUnzipCmd(platform = process.platform) {
  const chain = extractorChain({ platform });
  if (!chain.length) return () => ({ status: 127 }); // nothing extractable on this box
  return (zip, dir) => {
    let last;
    for (const name of chain) {
      const r = EXTRACTORS[name](zip, dir);
      if (r.status === 0) return r;
      last = { ...r, __executor: name }; // which tool failed — actionable errors
    }
    return last; // all tried, all failed — surface the last status + which executor was last
// (callers see r.stderr/r.error for the diagnostic; defaultUnzipCmd annotates via __executor)
  };
}
