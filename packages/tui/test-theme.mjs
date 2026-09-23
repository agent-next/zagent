import { createTheme, TOKENS, GLYPH, ASCII_GLYPH } from './theme.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

const dark = createTheme({ enabled: true });
const light = createTheme({ enabled: true, colorScheme: 'light' });
const off = createTheme({ enabled: false });

ok(TOKENS.length === 21, `21 semantic tokens (got ${TOKENS.length})`);
ok(TOKENS.every(t => typeof dark[t] === 'function'), 'every token is a painter function');
ok(TOKENS.every(t => typeof light[t] === 'function'), 'light scheme defines every token too');

ok(dark.accent('x') === '\x1b[38;5;173mx\x1b[0m', 'accent paints with the coral 256-color code');
ok(light.accent('x') !== dark.accent('x'), 'light and dark differ');
ok(dark.colorScheme === 'dark' && light.colorScheme === 'light', 'scheme is reported back');
ok(createTheme({ enabled: true, colorScheme: 'nonsense' }).colorScheme === 'dark', 'unknown scheme falls back to dark');

// text is the one intentionally unpainted token: body prose keeps the user's own fg
ok(dark.text('x') === 'x', 'text token leaves the terminal foreground alone');

ok(TOKENS.every(t => off[t]('x') === 'x'), 'disabled theme is a pure passthrough for every token');
ok(!TOKENS.map(t => off[t]('x')).join('').includes('\x1b'), 'disabled theme emits no escapes');

// Nested styles: an inner reset must not strip the outer color from the tail.
const nested = dark.muted(`a${dark.accent('b')}c`);
ok(nested.endsWith('c\x1b[0m') && nested.split('\x1b[38;5;245m').length === 3,
   'an inner reset reopens the outer style so the tail keeps its color');

ok(dark.glyph === GLYPH && createTheme({ ascii: true }).glyph === ASCII_GLYPH, 'ascii mode swaps the glyph table');
ok(Object.keys(GLYPH).every(k => k in ASCII_GLYPH), 'the ascii table covers every glyph');
ok(ASCII_GLYPH.spinner.length > 0 && GLYPH.spinner.length > 0, 'both glyph tables have spinner frames');
ok(!Object.entries(ASCII_GLYPH).some(([k, v]) => typeof v === 'string' && /[^\x00-\x7f]/.test(v)),
   'the ascii table contains no non-ascii characters');

// NO_COLOR is the user's machine-wide opt-out and outranks an explicit enable.
const prev = process.env.NO_COLOR;
process.env.NO_COLOR = '1';
ok(createTheme({ enabled: true }).accent('x') === 'x', 'NO_COLOR disables color even when enabled is requested');
if (prev === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = prev;

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
