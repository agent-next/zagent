// E1: attachment DETECTION on bot surfaces (2026-09-06). The coding-plan text lane
// cannot carry arbitrary binaries into the model — we DETECT and DISCLOSE rather than
// silently drop: handlers reply with what arrived so senders know to paste content.
// Feishu im.message.receive_v1: content JSON may carry {"image_key":…} / {"file_key":…}
// (plus message_type image/file at the envelope level); Telegram: photo[] / document{}.
export function feishuAttachments(event) {
  const msg = event?.event?.message ?? {};
  const out = [];
  const push = (kind, id) => id && out.push({ kind, id: String(id) });
  if (msg.message_type === 'image' || msg.message_type === 'file') out.push({ kind: msg.message_type, id: '(envelope)' });
  let c = null; try { c = JSON.parse(msg.content ?? '{}'); } catch {}
  push('image', c?.image_key); push('file', c?.file_key);
  for (const k of ['images', 'files']) for (const it of (c?.[k] ?? [])) push(k === 'images' ? 'image' : 'file', it?.image_key ?? it?.file_key ?? it?.key);
  return out;
}

export function telegramAttachments(message) {
  const out = [];
  for (const p of message?.photo ?? []) out.push({ kind: 'image', id: `photo-${p.file_id ?? p.width}` });
  if (message?.document) out.push({ kind: 'file', id: `doc-${message.document.file_id ?? message.document.file_name ?? '?'}` });
  if (message?.video) out.push({ kind: 'video', id: `video-${message.video.file_id ?? '?'}` });
  if (message?.voice) out.push({ kind: 'voice', id: `voice-${message.voice.file_id ?? '?'}` });
  return out;
}

export function attachmentsNote(list) {
  if (!list?.length) return null;
  const kinds = list.map(a => a.kind).join(', ');
  return `attachment received (${kinds}) — this bot runs the text coding plan; binary content is not forwarded. Paste text or use @file mentions.`;
}
