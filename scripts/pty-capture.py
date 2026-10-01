#!/usr/bin/env python3
"""Drive a terminal program in a real PTY and snapshot what a human would SEE.

The raw byte stream of a full-screen TUI (alt screen, absolute cursor moves,
erase sequences) is unreadable and grep on it lies; this replays the stream
through a VT100 emulator (pyte) and writes the rendered screen per snapshot.

    pty-capture.py --out DIR --cmd 'codex' [--cols 120 --rows 40] [--home fresh|real|PATH]
                   --step wait:3 --step type:/ --step snap:palette --step key:esc --step key:c-c ...

Steps (in order): wait:<sec> | type:<text> | key:<enter|esc|tab|s-tab|up|down|bs|c-c|c-d|c-q|c-u|c-p|c-t|c-o|c-r> | snap:<name>
`type:` sends the text verbatim (no escape processing) — a typed line followed by key:enter IS a prompt: it starts a model turn.
Outputs: DIR/<name>.txt (screen), DIR/raw.bin (every byte, unredacted — a .gitignore is written so it
cannot be committed by accident), DIR/meta.json (cmd, env, exit).
The pexpect child is already a session/process-group leader (ptyprocess calls setsid);
cleanup kills the whole process group, so grandchildren cannot orphan.
Credential-looking env vars (KEY/TOKEN/SECRET/PASS/AUTH/CRED) are stripped from the child env;
pass what you need explicitly with --env K=V.
Needs: pyte, pexpect (pip). Never runs a model turn by itself — only the keys you script.
"""
import argparse, json, os, re, shutil, signal, sys, tempfile, time
import pexpect, pyte

KEYS = {'enter': '\r', 'esc': '\x1b', 'tab': '\t', 'up': '\x1b[A', 'down': '\x1b[B',
        'c-c': '\x03', 'c-d': '\x04', 'c-q': '\x11', 'c-l': '\x0c', 'bs': '\x7f', 'space': ' ',
        's-tab': '\x1b[Z', 'c-u': '\x15', 'c-p': '\x10', 'c-t': '\x14', 'c-o': '\x0f', 'c-r': '\x12'}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True); ap.add_argument('--cmd', required=True)
    ap.add_argument('--cols', type=int, default=120); ap.add_argument('--rows', type=int, default=40)
    ap.add_argument('--home', default='real', help="'real', 'fresh' (empty temp HOME) or a path")
    ap.add_argument('--cwd', default=None); ap.add_argument('--env', action='append', default=[], help='K=V')
    ap.add_argument('--step', action='append', default=[]); ap.add_argument('--timeout', type=float, default=90)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, '.gitignore'), 'w') as f: f.write('raw.bin\n')
    env = {k: v for k, v in os.environ.items() if not re.search(r'KEY|TOKEN|SECRET|PASS|AUTH|CRED', k, re.I)}
    env.update(TERM='xterm-256color', COLUMNS=str(a.cols), LINES=str(a.rows), NO_COLOR='1')
    fresh = None
    if a.home == 'fresh':
        fresh = tempfile.mkdtemp(prefix='pty-home-'); env['HOME'] = fresh
        for k in ('XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'): env.pop(k, None)
    elif a.home != 'real':
        env['HOME'] = a.home
    for kv in a.env:
        k, _, v = kv.partition('='); env[k] = v
    screen = pyte.Screen(a.cols, a.rows); stream = pyte.ByteStream(screen)
    raw = open(os.path.join(a.out, 'raw.bin'), 'wb')
    t0 = time.time()
    child = pexpect.spawn('/bin/sh', ['-c', a.cmd], env=env, cwd=a.cwd, dimensions=(a.rows, a.cols), timeout=1, encoding=None)
    def drain(seconds):
        end = time.time() + seconds
        while time.time() < end:
            try:
                data = child.read_nonblocking(65536, timeout=0.2)
                raw.write(data); stream.feed(data)
            except pexpect.TIMEOUT:
                pass
            except pexpect.EOF:
                return False
        return True
    def snap(name):
        lines = [l.rstrip() for l in screen.display]
        while lines and not lines[-1]: lines.pop()
        with open(os.path.join(a.out, f'{name}.txt'), 'w') as f:
            f.write('\n'.join(lines) + '\n')
        print(f'[snap] {name}: {sum(1 for l in lines if l.strip())} non-empty rows', file=sys.stderr)
    alive = True
    for step in a.step:
        kind, _, arg = step.partition(':')
        if time.time() - t0 > a.timeout: print('[timeout] budget exhausted', file=sys.stderr); break
        if kind == 'wait': alive = drain(float(arg))
        elif kind == 'type':
            child.send(arg.encode()); alive = drain(0.4)
        elif kind == 'key':
            child.send(KEYS[arg].encode()); alive = drain(0.4)
        elif kind == 'snap': snap(arg)
        else: raise SystemExit(f'unknown step {step}')
        if not alive: print('[eof] program exited', file=sys.stderr)
    # make sure the program is gone
    for sig in ('\x03', '\x03', '\x04'):
        try: child.send(sig.encode()); drain(0.3)
        except Exception: pass
    try: child.close(force=True)
    except Exception: pass
    try: os.killpg(child.pid, signal.SIGKILL)  # ptyprocess setsid'd the child: it leads its group
    except Exception: pass
    raw.close()
    meta = {'cmd': a.cmd, 'home': env.get('HOME'), 'cols': a.cols, 'rows': a.rows, 'exit': child.exitstatus,
            'signal': child.signalstatus, 'seconds': round(time.time() - t0, 1), 'steps': a.step}
    json.dump(meta, open(os.path.join(a.out, 'meta.json'), 'w'), indent=1)
    if fresh: shutil.rmtree(fresh, ignore_errors=True)

if __name__ == '__main__':
    main()
