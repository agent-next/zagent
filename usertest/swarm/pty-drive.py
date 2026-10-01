#!/usr/bin/env python3
r"""pty-drive — drive a command inside a REAL pty and snapshot the screen.

Stdlib-only on purpose: the flock sandbox (bwrap) has /usr/bin/python3 but no
pip and no site-packages — pexpect/pyte are unreachable inside the wall.

Usage:
  python3 pty-drive.py SCRIPT DUMP_DIR -- CMD [ARGS...]

SCRIPT is a text file, one action per line ('#' comments and blanks ignored):

  wait <ms>                    keep draining the child for N ms
  send <text>                  write text verbatim (\n \t \r \e \xNN escapes ok)
  key <name>                   enter|esc|tab|backspace|delete|ctrl-c|ctrl-d|
                               ctrl-z|up|down|left|right|home|end|shift-tab
  snap <label>                 render the screen now -> DUMP_DIR/NN-<label>.txt
  expect <regex> [ms]          wait (default 8000ms) for regex on the rendered
                               screen; prints EXPECT-OK / EXPECT-TIMEOUT lines
  resize <cols>x<rows>         TIOCSWINSZ + SIGWINCH, like a window drag

The child gets TERM=xterm-256color (or $ZAGENT_PTY_TERM) and COLUMNS/LINES
matching the pty. On child exit (or script end + a short drain) the final
frame lands in DUMP_DIR/final.txt and every byte in DUMP_DIR/raw.bin.
The driver's own stdout carries step markers (SNAP/EXPECT-*/EXIT) a human
judge can cite; exit code is 2 for a bad script line, else 0 (a child that
fails to exec shows up as EXIT 127 in the dumps, not a driver error).
"""
import codecs
import fcntl
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time
import unicodedata


class Screen:
    """Minimal VT100-ish model — enough to judge what a human would see:
    cursor moves, erases, scroll regions (DECSTBM + SU/SD/IND/RI), insert/
    delete, alt screen (1049), deferred wrap, wide + combining chars."""

    def __init__(self, cols=100, rows=30):
        self.cols, self.rows = cols, rows
        self.grid = [[' '] * cols for _ in range(rows)]
        self.curx = self.cury = 0
        self.saved = (0, 0)
        self.top, self.bot = 0, rows - 1
        self.wrap_pending = False
        self.alt = None  # saved (grid, cursor) while the alt screen is up
        self.state = 'g'  # g round | e sc | c si | o sc | d cs | s kip-one
        self.param = ''
        self.last_ch = ' '

    def _blank(self):
        return [' '] * self.cols

    def resize(self, cols, rows):
        cols, rows = max(4, cols), max(2, rows)
        g = [row[:cols] + [' '] * max(0, cols - len(row)) for row in self.grid[:rows]]
        # _blank() reads self.cols — still the OLD width here, so grown rows
        # must be built at the new width literally (a stale-width row crashes
        # _put on the first write past it — the opencode 60x18→110x34 escape).
        g += [[' '] * cols for _ in range(max(0, rows - len(g)))]
        self.cols, self.rows, self.grid = cols, rows, g
        self.top, self.bot = 0, rows - 1
        self.curx, self.cury = min(self.curx, cols - 1), min(self.cury, rows - 1)
        self.wrap_pending = False

    def _restore(self):
        # A cursor saved pre-resize (or on the alt screen's other geometry)
        # can name cells that no longer exist — clamp like a real terminal
        # (xterm clamps at restore time only, so saved keeps its literal
        # value and a shrink→grow→restore still recovers the original cell).
        self.curx = min(self.saved[0], self.cols - 1)
        self.cury = min(self.saved[1], self.rows - 1)
        self.wrap_pending = False

    def _scroll_up(self, top, bot, n):
        n = min(n, bot - top + 1)
        self.grid[top:bot + 1] = self.grid[top + n:bot + 1] + [self._blank() for _ in range(n)]

    def _scroll_down(self, top, bot, n):
        n = min(n, bot - top + 1)
        self.grid[top:bot + 1] = [self._blank() for _ in range(n)] + self.grid[top:bot - n + 1]

    def _index(self):
        if self.cury == self.bot:
            self._scroll_up(self.top, self.bot, 1)
        elif self.cury < self.rows - 1:
            self.cury += 1

    def _ri(self):
        if self.cury == self.top:
            self._scroll_down(self.top, self.bot, 1)
        elif self.cury > 0:
            self.cury -= 1

    def _newline(self):
        self.curx = 0
        self.wrap_pending = False
        self._index()

    def _put(self, ch):
        if self.wrap_pending:
            self._newline()
        w = 2 if unicodedata.east_asian_width(ch) in ('W', 'F') else 1
        if unicodedata.combining(ch):
            w = 0
        if w == 0:
            # Merge a combining mark into the occupied cell to the left
            # (skipping '' wide-char continuations to reach the base cell).
            x, y = (self.curx - 1, self.cury) if self.curx else ((self.cols - 1, self.cury - 1) if self.cury else (-1, -1))
            while y >= 0 and x >= 0 and self.grid[y][x] == '':
                x -= 1
            if y >= 0 and x >= 0:
                self.grid[y][x] += ch
            return
        if w == 2 and self.curx == self.cols - 1:
            self._newline()
        self.grid[self.cury][self.curx] = ch
        self.last_ch = ch
        if w == 2 and self.curx + 1 < self.cols:
            self.grid[self.cury][self.curx + 1] = ''
        self.curx += w
        if self.curx >= self.cols:
            self.curx = self.cols - 1
            self.wrap_pending = True

    def _erase_line(self, mode):
        row = self.grid[self.cury]
        if mode == 0:
            row[self.curx:] = [' '] * (self.cols - self.curx)
        elif mode == 1:
            row[:self.curx + 1] = [' '] * (self.curx + 1)
        else:
            self.grid[self.cury] = self._blank()

    def _erase_screen(self, mode):
        if mode == 0:
            self._erase_line(0)
            for y in range(self.cury + 1, self.rows):
                self.grid[y] = self._blank()
        elif mode == 1:
            self._erase_line(1)
            for y in range(self.cury):
                self.grid[y] = self._blank()
        else:
            self.grid = [self._blank() for _ in range(self.rows)]

    def _params(self, default=0):
        # '5;3' -> [5,3]; '' -> [default]; '?25' handled via self.private
        p = self.param.lstrip('?')
        if not p:
            return [default]
        out = []
        for t in p.split(';'):
            t = t.lstrip('?>')
            try:
                out.append(int(t) if t else default)
            except ValueError:
                out.append(default)
        return out or [default]

    def _csi(self, final):
        private = self.param.startswith('?')
        p = self._params(0)
        n = p[0] or 1
        self.wrap_pending = False
        if final == 'A':
            self.cury = max(0, self.cury - n)
        elif final == 'B' or final == 'e':
            self.cury = min(self.rows - 1, self.cury + n)
        elif final == 'C' or final == 'a':
            self.curx = min(self.cols - 1, self.curx + n)
        elif final == 'D':
            self.curx = max(0, self.curx - n)
        elif final == 'E':
            self.cury = min(self.rows - 1, self.cury + n); self.curx = 0
        elif final == 'F':
            self.cury = max(0, self.cury - n); self.curx = 0
        elif final == 'G' or final == '`':
            self.curx = min(self.cols - 1, (p[0] or 1) - 1)
        elif final in ('H', 'f'):
            r = (p[0] or 1) - 1
            c = (p[1] if len(p) > 1 else 1) - 1
            self.cury = min(self.rows - 1, max(0, r))
            self.curx = min(self.cols - 1, max(0, c))
        elif final == 'd':
            self.cury = min(self.rows - 1, (p[0] or 1) - 1)
        elif final == 'J':
            self._erase_screen(min(p[0], 3))
        elif final == 'K':
            self._erase_line(min(p[0], 2))
        elif final == 'L':
            if self.top <= self.cury <= self.bot:
                self._scroll_down(self.cury, self.bot, n)
        elif final == 'M':
            if self.top <= self.cury <= self.bot:
                self._scroll_up(self.cury, self.bot, n)
        elif final == 'P':
            row = self.grid[self.cury]
            del row[self.curx:self.curx + n]
            row += [' '] * max(0, self.cols - len(row))
            del row[self.cols:]
        elif final == '@':
            row = self.grid[self.cury]
            row[self.curx:self.curx] = [' '] * n; del row[self.cols:]
        elif final == 'X':
            row = self.grid[self.cury]
            row[self.curx:self.curx + n] = [' '] * min(n, self.cols - self.curx)
        elif final == 'S':
            self._scroll_up(self.top, self.bot, n)
        elif final == 'T':
            if len(self.param.lstrip('?').split(';')) > 1 or private:
                return  # non-scroll uses of CSI T (initiate hilite etc.)
            self._scroll_down(self.top, self.bot, n)
        elif final == 'r':
            t = (p[0] or 1) - 1
            b = (p[1] if len(p) > 1 and p[1] else self.rows) - 1
            if 0 <= t < b < self.rows:
                self.top, self.bot = t, b
            self.curx = self.cury = 0
        elif final == 'b':
            for _ in range(n):
                self._put(self.last_ch)
        elif final == 's':
            # Bare CSI s = SCOSC save cursor. ANY param byte means another
            # op (?s XTSAVE and other private/intermediate-marked forms) —
            # never a cursor save.
            if self.param == '':
                self.saved = (self.curx, self.cury)
        elif final == 'u':
            # Bare CSI u = SCORC restore cursor. Kitty keyboard sequences
            # (>Nu push, <u pop, =f;m u set, ?u query) share the 'u' final —
            # restoring here jumps the cursor to a stale saved position and
            # corrupts every frame after the kitty init push.
            if self.param == '':
                self._restore()
        elif final in ('h', 'l') and private:
            if 1049 in p or 1047 in p:
                if final == 'h':
                    if self.alt is None:
                        self.alt = (self.grid, (self.curx, self.cury))
                        self.grid = [self._blank() for _ in range(self.rows)]
                        self.curx = self.cury = 0
                elif self.alt is not None:
                    self.grid, (self.curx, self.cury) = self.alt
                    self.alt = None
                    self.resize(self.cols, self.rows)
            elif 1048 in p:  # lone DECSC/DECRC private pair — cursor only, NOT alt screen
                if final == 'h':
                    self.saved = (self.curx, self.cury)
                else:
                    self._restore()
        # m (SGR), n (DSR), c (DA), t, q and friends: presentation only.

    def _esc(self, ch):
        if ch == '7':
            self.saved = (self.curx, self.cury)
        elif ch == '8':
            self._restore()
        elif ch == 'D':
            self._index()
        elif ch == 'M':
            self._ri()
        elif ch == 'E':
            self._newline()
        elif ch == 'c':
            alt = self.alt
            cols, rows = self.cols, self.rows
            self.__init__(cols, rows)
            self.alt = alt

    def feed(self, text):
        for ch in text:
            o = ord(ch)
            if self.state == 'g':
                if ch == '\x1b':
                    self.state = 'e'
                elif ch in ('\n', '\v', '\f'):
                    self._index()
                    if self.wrap_pending:
                        self.wrap_pending = False
                elif ch == '\r':
                    self.curx = 0
                    self.wrap_pending = False
                elif ch == '\b':
                    self.curx = max(0, self.curx - 1)
                    self.wrap_pending = False
                elif ch == '\t':
                    self.curx = min(self.cols - 1, (self.curx // 8 + 1) * 8)
                elif 0x20 <= o < 0x7f or o >= 0xa0:
                    self._put(ch)
                # DEL and C1 bytes (0x7f-0x9f) are not printable — real
                # terminals drop them rather than painting glyphs. Remaining
                # C0 (BEL, SO/SI ...) has no screen effect either.
            elif self.state == 'e':
                if ch == '[':
                    self.state = 'c'; self.param = ''
                elif ch == ']':
                    self.state = 'o'
                elif ch in 'PX^_':
                    self.state = 'd'
                elif ch in '()*#':
                    self.state = 's' if ch != '#' else 'h'  # charset vs DECALN
                else:
                    self._esc(ch)
                    self.state = 'g'
            elif self.state == 's':
                self.state = 'g'
            elif self.state == 'h':
                if ch == '8':  # DECALN: the screen-alignment test fills with E
                    self.grid = [['E'] * self.cols for _ in range(self.rows)]
                self.state = 'g'
            elif self.state == 'c':
                if ch == '\x1b':
                    self.state = 'e'  # ESC aborts the in-flight sequence
                elif 0x40 <= o <= 0x7E:
                    self._csi(ch)
                    self.state = 'g'
                elif len(self.param) < 4096:
                    self.param += ch
            elif self.state in ('o', 'd'):
                if ch == '\x07' and self.state == 'o':
                    self.state = 'g'
                elif ch == '\x1b':
                    self.state = 'e'  # ESC \ (ST) lands as a no-op esc
        return

    def render(self):
        lines = []
        for row in self.grid:
            lines.append(''.join(c if isinstance(c, str) and c else ' ' for c in row).rstrip())
        while lines and not lines[-1]:
            lines.pop()
        return '\n'.join(lines)


KEYS = {
    'enter': b'\r', 'esc': b'\x1b', 'escape': b'\x1b', 'tab': b'\t',
    'backspace': b'\x7f', 'delete': b'\x1b[3~', 'shift-tab': b'\x1b[Z',
    'ctrl-c': b'\x03', 'ctrl+c': b'\x03',  # models write both spellings
    'ctrl-d': b'\x04', 'ctrl-z': b'\x1a', 'ctrl-l': b'\x0c',
    'up': b'\x1b[A', 'down': b'\x1b[B', 'right': b'\x1b[C', 'left': b'\x1b[D',
    'home': b'\x1b[H', 'end': b'\x1b[F', 'space': b' ',
}


def unescape(s):
    def rep(m):
        t = m.group(1)
        return {'n': '\n', 't': '\t', 'r': '\r', 'e': '\x1b', '0': '\0'}.get(
            t, chr(int(t[1:], 16)) if re.fullmatch(r'x[0-9a-fA-F]{2}', t) else '\\' + t)
    return re.sub(r'\\(x[0-9a-fA-F]{2}|.)', rep, s)


def parse_script(path):
    steps = []
    for ln, raw in enumerate(open(path, encoding='utf-8'), 1):
        line = raw.rstrip('\n')
        s = line.strip()
        if not s or s.startswith('#'):
            continue
        verb, _, rest = s.partition(' ')
        verb = verb.lower()
        steps.append((ln, verb, rest.strip()))
    return steps


def main(argv):
    if '--' not in argv:
        sys.stderr.write(__doc__)
        return 2
    sep = argv.index('--')
    if sep < 2:
        sys.stderr.write('usage: pty-drive.py SCRIPT DUMP_DIR -- CMD [ARGS...]\n')
        return 2
    script_path, dump_dir, cmd = argv[0], argv[1], argv[sep + 1:]
    if not cmd:
        sys.stderr.write('pty-drive: missing CMD after --\n')
        return 2
    try:
        steps = parse_script(script_path)
    except OSError as e:
        sys.stderr.write(f'pty-drive: cannot read script: {e}\n')
        return 2
    os.makedirs(dump_dir, exist_ok=True)

    cols, rows = 100, 30
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        env['TERM'] = env.get('ZAGENT_PTY_TERM') or 'xterm-256color'
        env['COLUMNS'], env['LINES'] = str(cols), str(rows)
        try:
            os.execvpe(cmd[0], cmd, env)
        except Exception as e:  # noqa: BLE001 - child: report and die
            sys.stderr.write(f'pty-drive: spawn failed: {e}\n')
        os._exit(127)

    scr = Screen(cols, rows)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
    os.set_blocking(fd, False)
    dec = codecs.getincrementaldecoder('utf-8')(errors='replace')
    raw = bytearray()
    dead = False
    status = None

    def reap():
        nonlocal dead, status
        if dead:
            return dead
        try:
            wpid, st = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            dead, status = True, 0
            return dead
        if wpid == pid:
            dead = True
            status = os.waitstatus_to_exitcode(st)
        return dead

    def drain(ms):
        end = time.monotonic() + ms / 1000.0
        while True:
            if reap():
                # Child is gone — drain whatever the pty still holds.
                while True:
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError:
                        break
                    if not chunk:
                        break
                    if len(raw) < 64_000_000:
                        raw.extend(chunk)
                    scr.feed(dec.decode(chunk))
                return
            left = end - time.monotonic()
            if left <= 0:
                return
            r, _, _ = select.select([fd], [], [], min(left, 0.05))
            if not r:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                reap()
                return
            if not chunk:
                reap()
                return
            if len(raw) < 64_000_000:  # cap: a runaway child cannot fill the disk
                raw.extend(chunk)
            scr.feed(dec.decode(chunk))

    def write_all(data):
        # fd is nonblocking — a big paste can short-write; keep at it until
        # the byte count is exact (a silently truncated keystroke is a lie
        # the human judge cannot see). Bounded: a child that never reads is
        # a wedge the agent should see as INPUT-FAILED, not a hung driver.
        view = memoryview(data)
        deadline = time.monotonic() + 10
        while len(view):
            try:
                n = os.write(fd, view)
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise OSError('pty write stalled >10s — child not reading')
                select.select([], [fd], [], 0.2)
                continue
            view = view[n:]

    snap_n = 0

    def snap(label):
        nonlocal snap_n
        snap_n += 1
        label = re.sub(r'[^A-Za-z0-9_.-]+', '-', label).strip('-') or f's{snap_n}'
        out = os.path.join(dump_dir, f'{snap_n:02d}-{label}.txt')
        with open(out, 'w', encoding='utf-8') as f:
            f.write(f'--- snap {label} n={snap_n} rows={scr.rows} cols={scr.cols} '
                    f'cursor={scr.cury},{scr.curx} ---\n')
            f.write(scr.render() + '\n')
        print(f'SNAP {out}')
        return out

    bad = False
    for ln, verb, rest in steps:
        # snap/expect/wait stay meaningful after the child dies (the model
        # still holds the final screen); only input actions need it alive.
        if dead and verb in ('send', 'key', 'resize'):
            print(f'CHILD-EXITED before line {ln}')
            break
        if verb == 'wait':
            try:
                ms = int(rest or '500')
            except ValueError:
                print(f'SCRIPT-ERR line {ln}: bad wait {rest!r} (want ms)', file=sys.stderr)
                bad = True
                break
            drain(ms)
        elif verb == 'send':
            try:
                write_all(unescape(rest).encode('utf-8'))
            except OSError as e:
                dead = True
                print(f'INPUT-FAILED before line {ln} ({e})')
                break
        elif verb == 'key':
            name = rest.lower()
            if name not in KEYS:
                print(f'SCRIPT-ERR line {ln}: unknown key {rest!r}', file=sys.stderr)
                bad = True
                break
            try:
                write_all(KEYS[name])
            except OSError as e:
                dead = True
                print(f'INPUT-FAILED before line {ln} ({e})')
                break
        elif verb == 'snap':
            snap(rest)
        elif verb == 'expect':
            parts = rest.rsplit(' ', 1)
            pat, timeout = (parts[0], int(parts[1])) if len(parts) > 1 and parts[1].isdigit() else (rest, 8000)
            try:
                rx = re.compile(pat, re.M)
            except re.error as e:
                print(f'SCRIPT-ERR line {ln}: bad expect regex ({e})', file=sys.stderr)
                bad = True
                break
            deadline = time.monotonic() + timeout / 1000.0
            hit = bool(rx.search(scr.render()))
            while not hit and not dead and time.monotonic() < deadline:
                drain(60)
                hit = bool(rx.search(scr.render()))
            if not hit:  # final check AFTER the last drain (bytes that arrive with death count)
                drain(60)
                hit = bool(rx.search(scr.render()))
            print(('EXPECT-OK ' if hit else 'EXPECT-TIMEOUT ') + pat)
        elif verb == 'resize':
            m = re.match(r'^(\d+)x(\d+)$', rest)
            if not m:
                print(f'SCRIPT-ERR line {ln}: bad resize {rest!r} (want COLSxROWS)', file=sys.stderr)
                bad = True
                break
            # Clamp like resize() does — the model and the child's winsize
            # must agree or every later frame diverges.
            cols, rows = max(4, int(m.group(1))), max(2, int(m.group(2)))
            scr.resize(cols, rows)
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
            try:
                os.kill(pid, signal.SIGWINCH)
            except OSError:
                dead = True
        else:
            print(f'SCRIPT-ERR line {ln}: unknown action {verb!r}', file=sys.stderr)
            bad = True
            break

    drain(800)  # settle trailing output
    if not dead:
        reap()
    if not dead:
        time.sleep(0.3)
        reap()
    if not dead:
        try:
            os.kill(pid, signal.SIGKILL)
        except OSError:
            pass
        try:
            _, st = os.waitpid(pid, 0)  # SIGKILL is certain — reap it, don't guess
            status = os.waitstatus_to_exitcode(st)
        except (ChildProcessError, OSError):
            pass
        dead = True

    with open(os.path.join(dump_dir, 'final.txt'), 'w', encoding='utf-8') as f:
        f.write(f'--- final exit={status} rows={scr.rows} cols={scr.cols} ---\n')
        f.write(scr.render() + '\n')
    with open(os.path.join(dump_dir, 'raw.bin'), 'wb') as f:
        f.write(bytes(raw))
    print('EXIT', status if status is not None else 'unknown')
    return 2 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
