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
 * The host can send two model-option shapes: the CLI catalog's
 * {id, alias?, name?} and the kernel registry's 3.12.x
 * {ref:{providerId,modelId}, label, providerLabel, ...}. Both normalize to a
 * provider/model pick value (the kernel's /model arg grammar on 3.12.x).
 */
export function modelOptionId(m) {
  if (typeof m?.id === 'string' && m.id.trim()) return m.id.trim();
  const ref = m?.ref;
  if (typeof ref?.providerId === 'string' && ref.providerId.trim() &&
      typeof ref?.modelId === 'string' && ref.modelId.trim())
    return `${ref.providerId.trim()}/${ref.modelId.trim()}`;
  return null;
}

/**
 * Is `current` (the ui.model grammar, e.g. 'zai/glm-5.3') this option? Exact
 * match on the normalized id, plus a case-insensitive modelId-tail match for
 * registry entries whose providerId ('builtin:*', 'account:*') never equals
 * the prefix ui.model carries. The tail fallback applies only to entries that
 * had no usable `id` of their own — an authoritative id is not reinterpreted.
 * Callers that can see the whole list should prefer exact hits first
 * (modelItems does the two-pass; single-entry finders stay benign since equal
 * modelIds share their contextWindow).
 */
export function modelOptionMatches(m, current) {
  const id = modelOptionId(m);
  if (!id || !current) return false;
  if (id === current) return true;
  if (typeof m?.id === 'string' && m.id.trim()) return false;
  const tail = String(current).split('/').pop()?.toLowerCase();
  return typeof m?.ref?.modelId === 'string' && m.ref.modelId.trim().toLowerCase() === tail;
}

// properties.inputFormat arrives as the builtin-catalog object
// {supportsText, supportsImage, supportsVideo, supportsAudio, supportsPdf}
// (zcode-builtin.json modelRules) — a delimited string/array form is also
// tolerated; absent/empty/unkeyed falls back to the supports* flags. An
// object that names any supports* key is authoritative even when all-false.
const INPUT_FLAGS = [['supportsImage', 'image'], ['supportsVideo', 'video'],
  ['supportsAudio', 'audio'], ['supportsPdf', 'pdf']];
function inputFormats(input) {
  if (!input) return null;
  if (typeof input === 'object' && !Array.isArray(input)) {
    const keyed = 'supportsText' in input || INPUT_FLAGS.some(([f]) => f in input);
    return keyed ? INPUT_FLAGS.filter(([f]) => input[f]).map(([, n]) => n) : null;
  }
  const text = Array.isArray(input) ? input.join(',') : String(input);
  if (!text.trim()) return null;
  return [/\bimage\b/i.test(text) && 'image', /\bvideo\b/i.test(text) && 'video',
    /\baudio\b/i.test(text) && 'audio', /\bpdf\b/i.test(text) && 'pdf'].filter(Boolean);
}

/**
 * modelOptions: [{alias, id, name, contextWindow, maxOutputTokens, reasoning,
 * supportsImages, supportsPdf, supportsVideo}] or the registry shape above.
 * The note carries what actually differs between main and lite — vision is
 * why you would pick the lite model.
 */
export function modelItems(modelOptions, current) {
  const list = Array.isArray(modelOptions) ? modelOptions : [];
  // two-pass: an exact id hit decides; the modelId tail only fills in when no
  // entry matched exactly (duplicate modelIds across providers must not all
  // light up as current).
  const exact = current ? list.some(m => modelOptionId(m) === current) : false;
  const isCurrent = (m) => exact ? modelOptionId(m) === current : modelOptionMatches(m, current);
  return list
    .map(m => {
      const id = modelOptionId(m);
      if (!id) return null;
      const media = inputFormats(m?.properties?.inputFormat)
        ?? [m.supportsImages && 'image', m.supportsVideo && 'video', m.supportsAudio && 'audio', m.supportsPdf && 'pdf'].filter(Boolean);
      const cur = isCurrent(m);
      const bits = [
        typeof m.alias === 'string' && m.alias ? m.alias
          : (typeof m.providerLabel === 'string' && m.providerLabel &&
             m.providerLabel.toLowerCase() !== String(m?.ref?.providerId ?? '').toLowerCase() ? m.providerLabel : null),
        media.length ? media.join('+') : null,
        cur ? '(current)' : null,
      ].filter(Boolean);
      const name = typeof m.name === 'string' && m.name ? m.name
        : typeof m.label === 'string' && m.label ? m.label : id;
      return { value: id, label: name, note: bits.join(' · '), current: cur };
    })
    .filter(Boolean);
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

/** A bare /effort, /model, /mode, /skill, /mcp or /goal — with no argument — is a request to choose. */
export function pickerFor(input) {
  const match = /^\/(effort|model|mode|skill|mcp|goal)\s*$/u.exec(String(input ?? '').trim());
  return match ? match[1] : null;
}
