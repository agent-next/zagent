// The runtime's three session knobs, as pickers.
//
// effortOptions, modelOptions and setMode are handed to the TUI by the host and
// were unused: /effort, /model and /mode worked only if you already knew the
// argument to type. These turn the data the runtime already gave us into a list
// you can see.
//
// Nothing here is hardcoded from documentation. Effort and model items come from
// the host arrays; the mode list is parsed out of the runtime's own /mode reply,
// so a runtime that adds a mode gains it here without a code change.

/** effortOptions: [{id, label}] — low/high/max, with the thinking budget behind them. */
export function effortItems(effortOptions, current) {
  const list = Array.isArray(effortOptions) ? effortOptions : [];
  return list
    .filter(o => o && typeof o.id === 'string')
    .map(o => ({
      value: o.id,
      label: typeof o.label === 'string' && o.label ? o.label : o.id,
      note: o.id === current ? '(current)' : '',
    }));
}

/**
 * modelOptions: [{alias, id, name, contextWindow, maxOutputTokens, reasoning,
 * supportsImages, supportsPdf, supportsVideo}]. The note carries what actually
 * differs between main and lite — vision is why you would pick the lite model.
 */
export function modelItems(modelOptions, current) {
  const list = Array.isArray(modelOptions) ? modelOptions : [];
  return list
    .filter(m => m && typeof m.id === 'string')
    .map(m => {
      const media = [m.supportsImages && 'image', m.supportsVideo && 'video', m.supportsPdf && 'pdf'].filter(Boolean);
      const bits = [
        typeof m.alias === 'string' ? m.alias : null,
        media.length ? media.join('+') : null,
        m.id === current ? '(current)' : null,
      ].filter(Boolean);
      return {
        value: m.id,
        label: typeof m.name === 'string' && m.name ? m.name : m.id,
        note: bits.join(' · '),
      };
    });
}

/**
 * Parse the runtime's own /mode reply rather than hardcoding the vocabulary:
 *   "Current mode: build. Available modes: plan, build, edit, yolo."
 * @returns {{items: Array<{value,label,note}>, current: string|null}|null}
 */
export function parseModes(response) {
  const text = typeof response === 'string' ? response : '';
  const available = /Available modes:\s*([^.]+)/iu.exec(text);
  if (!available) return null;
  const current = /Current mode:\s*([A-Za-z0-9_-]+)/iu.exec(text)?.[1] ?? null;
  const items = available[1]
    .split(/[,\s]+/u)
    .map(s => s.trim())
    .filter(Boolean)
    .map(mode => ({ value: mode, label: mode, note: mode === current ? '(current)' : '' }));
  return items.length ? { items, current } : null;
}

/** A bare /effort, /model or /mode — with no argument — is a request to choose. */
export function pickerFor(input) {
  const match = /^\/(effort|model|mode)\s*$/u.exec(String(input ?? '').trim());
  return match ? match[1] : null;
}
