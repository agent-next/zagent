// Differential: the retirement cache must be output-identical to no cache.
// Same event script twice — once with retirement active, once with the flag
// cleared before every frame — comparing the exact commit/live pair per frame.
import { createTranscript, applyEvent, addUserEntry, addNotice } from './events.mjs';
import { composeFrame } from './screen.mjs';
import { createTheme } from './theme.mjs';

const theme = createTheme({ enabled: true });

function run(defeatCache) {
  const s = createTranscript();
  const out = [];
  let width = 100;
  let fold = 'expanded';
  const step = () => {
    if (defeatCache) for (const e of s.entries) e.retired = undefined;
    const f = composeFrame(s, theme, width, { foldOf: () => fold });
    out.push('C:' + f.commit.join(''), 'L:' + f.live.join(''));
  };
  const ev = (type, payload) => applyEvent(s, { type, turnId: 't', payload });

  for (let turn = 0; turn < 30; turn++) {
    addUserEntry(s, 'q' + turn); step();
    ev('model_streaming', { assistantMessageId: 'm' + turn, delta: '', kind: 'start' }); step();
    for (let d = 0; d < 6; d++) {
      ev('model_streaming', { assistantMessageId: 'm' + turn, delta: 'word' + d + ' ', kind: 'text_delta' });
      step();
    }
    ev('tool_call_scheduled', { toolCallId: 'c' + turn, toolName: 'Bash', input: { command: 'ls -la' } }); step();
    ev('tool_call_result', { toolCallId: 'c' + turn, duration: 5, result: { success: true, content: 'out\n'.repeat(80) } }); step();
    ev('model_streaming', { assistantMessageId: 'm' + turn, delta: '', done: true, kind: 'finish' }); step();
    step(); step();                                          // idle spinner frames
    if (turn === 10) { width = 60; step(); step(); }          // resize mid-session
    if (turn === 15) { fold = 'collapsed'; step(); step(); }  // un-retire: fold flips every settled entry
    if (turn === 20) { fold = 'expanded'; step(); step(); }    // and back — re-anchor both directions
    if (turn === 25) { addNotice(s, 'a notice', 'warning'); step(); }
  }
  return out;
}

const cached = run(false);
const plain = run(true);
let diff = 0;
for (let i = 0; i < Math.max(cached.length, plain.length); i++) {
  if (cached[i] !== plain[i]) {
    if (diff < 3) {
      console.log(`  first diff at half-frame ${i}`);
      console.log('    cached:', String(cached[i] ?? '').slice(0, 100));
      console.log('    plain :', String(plain[i] ?? '').slice(0, 100));
    }
    diff++;
  }
}
console.log(`  ${cached.length / 2} frames compared -> ${diff} differences`);
console.log(diff === 0
  ? `ok - retirement is output-identical over ${cached.length / 2} frames (incl. resize + fold un-retire)`
  : `FAIL: retirement changed the output in ${diff} places`);
console.log(diff === 0 ? '\nALL PASS' : `\n1 FAILED`);
process.exit(diff === 0 ? 0 : 1);
