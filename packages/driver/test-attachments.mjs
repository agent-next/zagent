// E1 attachment detection tests — Feishu/TG documented shapes.
import { feishuAttachments, telegramAttachments, attachmentsNote } from './attachments.mjs';
let fails = 0;
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++; } else console.log('ok -', m); };

let a = feishuAttachments({ event: { message: { message_type: 'image', content: '{"image_key":"img_v2_abc"}' } } });
ok(a.length === 2 && a.some(x => x.id === 'img_v2_abc'), 'feishu envelope + image_key');
a = feishuAttachments({ event: { message: { content: '{"file_key":"file_v3_x"}' } } });
ok(a.length === 1 && a[0].kind === 'file', 'file_key detected');
ok(feishuAttachments({ event: { message: { content: '{"text":"plain"}' } } }).length === 0, 'plain none');
ok(feishuAttachments({ event: { message: { content: 'not json' } } }).length === 0, 'torn safe');
ok(feishuAttachments(null).length === 0, 'null safe');

let m = telegramAttachments({ photo: [{ file_id: 'f1' }, { file_id: 'f2' }], document: { file_id: 'd1' } });
ok(m.length === 3 && m[0].id === 'photo-f1' && m[2].kind === 'file', 'tg photos + doc');
m = telegramAttachments({ voice: { file_id: 'v9' } });
ok(m.length === 1 && m[0].kind === 'voice', 'voice');
ok(telegramAttachments({ text: 'hi' }).length === 0, 'text-only none');
ok(attachmentsNote([]) === null, 'no note');
ok(attachmentsNote([{ kind: 'image', id: 'x' }]).includes('text coding plan'), 'note explains limitation');
console.log('interim:', fails ? `FAIL (${fails})` : 'ok');

// r16: photo-only + caption reach handlers; feishu image events flow
import { messageText } from './telegram.mjs';
import { receiveEvent } from './feishu.mjs';
let mt = messageText({ message: { chat: { id: 1 }, photo: [{ file_id: 'p' }] } });
ok(mt && mt.text === '' && mt.chatId === 1, 'photo-only accepted with empty text');
mt = messageText({ message: { chat: { id: 1 }, caption: 'cap', photo: [{ file_id: 'p' }] } });
ok(mt.text === 'cap', 'caption becomes text');
ok(messageText({ message: { chat: { id: 1 } } }) === null, 'truly empty message still skipped');
let fe = receiveEvent({ header: { event_type: 'im.message.receive_v1' }, event: { message: { chat_id: 'c', message_id: 'm', message_type: 'image', content: '{"image_key":"ik"}' } } });
ok(fe.kind === 'message' && fe.text === '', 'feishu image event flows with empty text');
fe = receiveEvent({ header: { event_type: 'im.message.receive_v1' }, event: { message: { chat_id: 'c', message_id: 'm', message_type: 'post', content: '{"other":1}' } } });
ok(fe.kind === 'ignored', 'non-text non-attachment still ignored');
console.log(fails ? `FAIL (${fails})` : 'PASS attachments');
process.exit(fails ? 1 : 0);
