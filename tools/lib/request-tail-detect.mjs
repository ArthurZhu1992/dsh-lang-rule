/**
 * request-tail-detect.mjs — per-request 尾约束证据检测（纯函数，无副作用）。
 *
 * 为什么单独成模块：会话事件里 user 消息有两种落地结构——
 *   1) `data.message = { role, content, source }`（带消息包装）
 *   2) `data = { role, content, source }`（直接是消息体，dsh 0.2.2 的 runtime-context 快照就是这种）
 * 旧版 verify-installed 只读 `data.message`，于是把第 2 种形态的 user 消息整个漏掉（误报 degraded）。
 * 这里统一解包，并同时接受两种证据来源：
 *   - `source.kind === 'runtime-context'`（宿主 runtime context 通道）
 *   - 正文含 REQUEST_TEXT 特征 + `<system-reminder>` 包裹（即便 source.kind 被别的插件改写也认）
 *
 * 注意：这是「看注入是否发生」的检测器，不评价模型行为；行为结论由 lang-audit / evolve-test live 层给。
 */

/**
 * 判据词：命中任意一条即视为尾约束在场。
 * v3 主判据在前（可判定形态），v2 旧文本保留以兼容历史会话（v2 vintage 的尾约束写法）。
 */
export const REQUEST_TAIL_MARKERS = [
  '包含中文字符',
  '含中文字符',
  '不得以 ASCII 字母开头',
  '第一句必须是简体中文',
  '英文任务提示不豁免',
  '禁止以 Let me',
];

/** 宿主 runtime context 快照里本插件 section 的注册名。 */
export const REQUEST_TAIL_SECTION_NAME = 'lang-rule:request-tail';

/** 解包事件里的消息体：兼容 `data.message` 与 `data` 两种形态。 */
export function messageOf(event) {
  const data = event?.data;
  if (data === null || typeof data !== 'object') return null;
  const wrapped = data.message;
  if (wrapped !== null && typeof wrapped === 'object') return wrapped;
  return data;
}

/** 把消息内容拼成纯文本（content 可能是字符串或 text block 数组）。 */
export function messageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block !== null && typeof block === 'object' && block.type === 'text' ? block.text : ''))
    .filter((text) => typeof text === 'string' && text !== '')
    .join('\n');
}

/** 该消息是否登记了 lang-rule:request-tail 这个 runtime-context section。 */
export function hasRequestTailSection(message) {
  const sections = message?.source?.sections;
  if (!Array.isArray(sections)) return false;
  return sections.some((section) => section?.name === REQUEST_TAIL_SECTION_NAME);
}

/**
 * 扫描会话事件，返回 per-request 尾约束证据。
 * @param {readonly any[]} events 会话事件（session.v4.jsonl 解压后逐行 JSON）
 * @returns {{found: boolean, via: 'runtime-context'|'user-system-reminder'|null, marker: string|null, sectionNameSeen: boolean, seq: number|null, excerpt: string|null}}
 */
export function detectRequestTailEvidence(events) {
  let fallback = null;
  for (const event of events ?? []) {
    if (event?.type !== 'user/message') continue;
    const message = messageOf(event);
    if (message === null) continue;
    const source = message.source ?? null;
    const sectionsText = Array.isArray(source?.sections)
      ? source.sections.map((section) => (typeof section?.text === 'string' ? section.text : '')).filter(Boolean).join('\n')
      : '';
    const text = [messageText(message), sectionsText].filter(Boolean).join('\n');
    if (text === '') continue;
    const marker = REQUEST_TAIL_MARKERS.find((needle) => text.includes(needle)) ?? null;
    const sectionNameSeen = hasRequestTailSection(message);
    if (marker === null && !sectionNameSeen) continue;

    const channel = typeof source?.kind === 'string' ? source.kind : null;
    const isRuntimeContext = channel === 'runtime-context';
    const isReminder = text.includes('<system-reminder');
    const anchorIndex = Math.max(0, text.indexOf(marker ?? '<system-reminder'));
    const hit = {
      found: true,
      // 注入落地形态：它是 user 消息里的 system-reminder 快照（宿主 runtime-context 通道生成）。
      via: isRuntimeContext || isReminder ? 'user-system-reminder' : 'user-message',
      channel,
      container: isReminder ? 'user-message/system-reminder' : 'user-message',
      marker,
      sectionNameSeen,
      seq: Number.isFinite(event?.seq) ? event.seq : null,
      excerpt: text.slice(anchorIndex, anchorIndex + 80),
    };
    // 优先返回带 system-reminder 包裹或 source.kind 明确的那条，语义最完整。
    if (isRuntimeContext || isReminder) return hit;
    fallback ??= hit;
  }
  return fallback ?? { found: false, via: null, channel: null, container: null, marker: null, sectionNameSeen: false, seq: null, excerpt: null };
}
