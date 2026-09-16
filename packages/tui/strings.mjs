// UI strings, keyed by the locale the runtime hands us.
//
// `host.locale` is one of the members the TUI was given and ignored. The runtime
// supports en-US, zh-CN and auto, and a large share of GLM Coding Plan users read
// Chinese — showing them an English-only interface on a Chinese model's client is
// a choice, and it was not a deliberate one.
//
// Only chrome is translated. Model output, tool names, file paths and runtime
// messages are passed through untouched: translating what the runtime said would
// be inventing words it did not say.

const EN = {
  placeholder: 'Ask a task about this workspace',
  hint: '/help for commands · esc to interrupt · ctrl+c twice to exit',
  // Rotating banner hints (G6): the single fixed line was the only place keys
  // were ever discoverable. Codex rotates a tip the same way.
  hints: [
    '/help for commands · esc to interrupt · ctrl+c twice to exit',
    '? for the shortcut list · / for commands · @ for files',
    'shift+up selects an earlier turn · h folds it, l expands it',
  ],
  working: 'working',
  interrupt: 'esc to interrupt',
  exitTwice: 'press ctrl+c again to exit',
  interrupted: 'interrupted',
  queued: (n) => `${n} queued`,
  tokens: (n) => `${n} tokens`,
  context: (used, window) => `${used}/${window ?? ''}`,
  retries: (n) => `${n} retr${n === 1 ? 'y' : 'ies'}`,
  failed: (n) => `${n} failed`,
  thinking: 'thinking',
  reasoningHidden: (n) => `… +${n} line${n === 1 ? '' : 's'} of reasoning`,
  linesHidden: (n) => `… +${n} line${n === 1 ? '' : 's'}`,
  truncatedByRuntime: '… truncated by the runtime',
  needsPermission: (tool) => `${tool} needs permission`,
  chooseHint: 'up/down/tab or 1-9 to choose · enter to confirm · esc to cancel',
  denyHint: 'up/down/tab or 1-9 to choose · enter to confirm · esc to deny',
  promptHint: 'enter to confirm · esc to cancel',
  sendNow: 'send now',
  editQueued: 'edit',
  cancelQueued: 'cancel',
  effortTitle: 'Reasoning effort',
  effortDetail: 'low 8k · high 16k · max 32k thinking budget',
  modelTitle: 'Model',
  modeTitle: 'Permission mode',
  noModelAccess: 'No model access configured. Run /login to sign in to your Coding Plan.',
  moreQueued: (n) => `↳ +${n} more queued`,
  moreCandidates: (n, pos, total) => `${pos}/${total}${n > 0 ? ` · +${n} more` : ''} · tab/pgdn moves · type to filter`,
  earlierLines: (n) => `… ${n} earlier line(s)`,
  imagePasted: (n) => `image attached (${n})`,
  noImage: 'no image in the clipboard',
  copied: 'copied to the clipboard',
  nothingToCopy: 'nothing to copy yet',
  goal: (g) => `goal ${g}`,
  mcpOk: (ok, n) => `mcp ${ok}/${n}`,
  mcpFailed: (ok, n, bad) => `mcp ${ok}/${n} · ${bad} failed`,
  agents: (n) => `agents ${n}`,
};

const ZH = {
  ...EN,
  placeholder: '输入你想让它做的事',
  hint: '/help 查看命令 · esc 中断 · 连按两次 ctrl+c 退出',
  hints: [
    '/help 查看命令 · esc 中断 · 连按两次 ctrl+c 退出',
    '? 查看快捷键 · / 命令 · @ 文件',
    'shift+up 选中更早的一轮 · h 折叠,l 展开',
  ],
  working: '处理中',
  interrupt: 'esc 中断',
  exitTwice: '再按一次 ctrl+c 退出',
  interrupted: '已中断',
  queued: (n) => `${n} 条排队`,
  tokens: (n) => `${n} tokens`,
  context: (used, window) => `${used}/${window ?? ''}`,
  retries: (n) => `重试 ${n} 次`,
  failed: (n) => `${n} 个失败`,
  thinking: '思考中',
  reasoningHidden: (n) => `… 另有 ${n} 行推理`,
  linesHidden: (n) => `… 另有 ${n} 行`,
  truncatedByRuntime: '… 已被 runtime 截断',
  needsPermission: (tool) => `${tool} 需要授权`,
  chooseHint: '上下键/tab 或 1-9 选择 · enter 确认 · esc 取消',
  denyHint: '上下键/tab 或 1-9 选择 · enter 确认 · esc 拒绝',
  promptHint: 'enter 确认 · esc 取消',
  sendNow: '发送',
  editQueued: '编辑',
  cancelQueued: '取消',
  effortTitle: '推理强度',
  effortDetail: 'low 8k · high 16k · max 32k 思考预算',
  modelTitle: '模型',
  modeTitle: '权限模式',
  noModelAccess: '尚未配置模型访问。运行 /login 登录你的 Coding Plan。',
  moreQueued: (n) => `↳ 另有 ${n} 条排队`,
  moreCandidates: (n, pos, total) => `${pos}/${total}${n > 0 ? ` · 另有 ${n} 项` : ''} · tab/pgdn 移动 · 输入筛选`,
  earlierLines: (n) => `… 上方还有 ${n} 行`,
  imagePasted: (n) => `已附加图片（${n}）`,
  noImage: '剪贴板中没有图片',
  copied: '已复制到剪贴板',
  nothingToCopy: '暂无可复制内容',
  goal: (g) => `目标 ${g}`,
  mcpOk: (ok, n) => `mcp ${ok}/${n}`,
  mcpFailed: (ok, n, bad) => `mcp ${ok}/${n} · ${bad} 失败`,
  agents: (n) => `子代理 ${n}`,
};

/** `auto` and anything unrecognised fall back to English. */
export function stringsFor(locale) {
  return String(locale ?? '').toLowerCase().startsWith('zh') ? ZH : EN;
}

export const LOCALES = Object.freeze(['en-US', 'zh-CN']);
