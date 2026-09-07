// cc-style palette for the native zagent TUI.
//
// Design notes (why this shape, not the runtime's):
//   * Semantic tokens only — call sites never name a color, so a re-skin is one
//     object. The official runtime's own TUI slot ships no palette at all, and
//     the third-party @zcode/tui hardcodes ANSI-256 per component.
//   * Restraint over decoration: Claude Code reads as prose with a few status
//     glyphs, not as a dashboard. Chrome is muted; color marks state, never
//     structure.
//   * 256-color codes, not truecolor: they degrade correctly over ssh/tmux/mosh
//     where COLORTERM is frequently unset or wrong.

const RESET = '\x1b[0m';

/** Nested styles must reopen after an inner reset, or the tail loses its color. */
function sgr(code, enabled) {
  if (!enabled) return (text) => text;
  const open = `\x1b[${code}m`;
  return (text) => `${open}${String(text).replaceAll(RESET, RESET + open)}${RESET}`;
}

// Coral (#D97757 -> 256-color 173) is Claude's mark; it is the ONLY saturated
// accent, so a glance finds the agent's own voice among tool noise.
const palettes = {
  dark: {
    accent: '38;5;173',
    userMark: '38;5;245',
    text: '',
    muted: '38;5;245',
    faint: '38;5;240',
    strong: '1',
    success: '38;5;71',
    warning: '38;5;179',
    error: '38;5;167',
    thinking: '38;5;140',
    code: '38;5;109',
    border: '38;5;238',
    borderActive: '38;5;173',
  },
  light: {
    accent: '38;5;166',
    userMark: '38;5;243',
    text: '',
    muted: '38;5;243',
    faint: '38;5;247',
    strong: '1',
    success: '38;5;28',
    warning: '38;5;130',
    error: '38;5;124',
    thinking: '38;5;97',
    code: '38;5;24',
    border: '38;5;251',
    borderActive: '38;5;166',
  },
};

export const TOKENS = Object.freeze(Object.keys(palettes.dark));

/** Glyphs, kept together so a --ascii fallback is one swap rather than a grep. */
export const GLYPH = Object.freeze({
  assistant: '⏺',   // ⏺ turn/tool marker
  result: '⎿',      // ⎿ tool-result continuation
  user: '>',
  bulletPending: '○', // ○
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  boxTL: '╭', boxTR: '╮', boxBL: '╰', boxBR: '╯',
  boxH: '─', boxV: '│',
});

export const ASCII_GLYPH = Object.freeze({
  ...GLYPH,
  assistant: '*', result: '\\_', bulletPending: 'o',
  spinner: ['|', '/', '-', '\\'],
  boxTL: '+', boxTR: '+', boxBL: '+', boxBR: '+', boxH: '-', boxV: '|',
});

/**
 * @param {{colorScheme?: 'dark'|'light', enabled?: boolean, ascii?: boolean}} options
 */
export function createTheme(options = {}) {
  const scheme = options.colorScheme === 'light' ? 'light' : 'dark';
  // NO_COLOR is honored even when the caller asks for color: it is the user's
  // machine-wide opt-out (no-color.org), and the runtime passes its own
  // --no-color through as options.enabled === false.
  const enabled = options.enabled !== false && !process.env.NO_COLOR;
  const palette = palettes[scheme];
  const theme = { colorScheme: scheme, enabled, glyph: options.ascii ? ASCII_GLYPH : GLYPH };
  for (const token of TOKENS) theme[token] = sgr(palette[token], enabled && palette[token] !== '');
  return theme;
}
