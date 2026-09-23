// Locale strings. host.locale was handed to the TUI and ignored — the runtime
// supports en-US / zh-CN / auto, and this is a Chinese model's client.
import { stringsFor, LOCALES } from './strings.mjs';
import { renderInputBox, renderStatus, renderBanner } from './chrome.mjs';
import { createTheme } from './theme.mjs';
import { createTranscript } from './events.mjs';
import { stringWidth } from './width.mjs';

let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };
const plain = createTheme({ enabled: false });

const en = stringsFor('en-US'), zh = stringsFor('zh-CN');
ok(en.placeholder !== zh.placeholder, 'the two locales differ');
ok(stringsFor('auto') === en && stringsFor() === en && stringsFor('fr-FR') === en,
   'auto, missing and unknown locales fall back to English');
ok(stringsFor('zh') === zh && stringsFor('ZH-CN') === zh, 'any zh tag selects Chinese, case-insensitively');

// Every key must exist in both, or a locale switch renders "undefined".
for (const key of Object.keys(en)) {
  ok(key in zh, `zh-CN defines ${key}`);
  ok(typeof zh[key] === typeof en[key], `${key} has the same shape in both`);
}
for (const [k, v] of Object.entries(en)) {
  if (typeof v !== 'function') continue;
  ok(typeof zh[k](2) === 'string' && zh[k](2).length > 0, `${k}() returns a string in zh-CN`);
}

// The reason locale matters here: Chinese is double-width, so a translated string
// that is not measured in cells breaks the box it sits in.
for (const width of [40, 62, 100]) {
  for (const str of [en, zh]) {
    const box = renderInputBox('', plain, width, { str });
    ok(box.every(l => stringWidth(l) === Math.max(20, width)),
       `input box is exactly ${width} cells with ${str === zh ? 'zh-CN' : 'en-US'} strings`);
    const busy = createTranscript();
    busy.turn = { active: true, startedAt: Date.now() - 1500, usage: { totalTokens: 15846 }, retries: 2, errors: 1, toolCalls: 0 };
    const line = renderStatus(busy, plain, width, { now: Date.now(), str });
    ok(line.length === 1 && stringWidth(line[0]) <= width,
       `status stays one line at ${width} cells with ${str === zh ? 'zh-CN' : 'en-US'}`);
    ok(renderBanner(plain, width, { version: '0.16.5', workspace: '/w', str }).every(l => stringWidth(l) <= width),
       `banner fits ${width} cells with ${str === zh ? 'zh-CN' : 'en-US'}`);
  }
}

ok(LOCALES.includes('zh-CN') && LOCALES.includes('en-US'), 'the supported locales are declared');
ok(zh.working !== en.working && zh.thinking !== en.thinking, 'the strings a user sees most are translated');
ok(zh.tokens(5) === en.tokens(5), 'units that are not words are left alone');

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
