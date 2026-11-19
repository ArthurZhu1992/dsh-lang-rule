/**
 * lang-metrics.mjs — 语言指标纯函数（lang-audit 与 selftest 共用）。
 *
 * v3 的关键口径：**「首句语言」与「整段 CJK 占比」是两个独立指标**，不能互相替代。
 * 实测反例：63,443 字符 / 21 段的任务首句中文，但整段 CJK 只有 0.222；
 * 406 字符 / 1 段的任务整段 CJK 0.910。把它们混成一个「中文率」会掩盖长任务稀释。
 *
 * 首句判定（与 README/harness 判据一致）：
 *   去掉行首 Markdown 定界符与空白 → 取首个句末标点前内容；
 *   若 CJK ≥1 且 CJK > 拉丁字母×0.5，且不以英文祈使句开头 → 中文首句。
 *
 * 只使用 node 内置能力，无副作用。
 */

/** CJK 占比阈值：低于它视为「英文主导」。 */
export const CJK_THRESHOLD = 0.2;

/**
 * 英文祈使/翻译式起手正则 —— **辅助判据，枚举永远不完备**。
 * 只在主判据（首字符不是 ASCII 字母，见 firstSentenceLanguage 判据①）未命中时补充识别
 * 英文祈使起手；它本身不得作为唯一判据（实测 `The task:`、`Here is` 等就不在表内）。
 */
export const ENGLISH_IMPERATIVE = /^(let me|let's|let us|i'll|i will|we need|we'll|the user|i need|i should|first,|ok,|okay,)/i;

/** 长任务分组阈值：字符数 > 10000 或 reasoning 段数 > 10。 */
export const LONG_TASK = Object.freeze({ chars: 10000, segments: 10 });

const CJK_PATTERN = /[\u4e00-\u9fff]/g;
const LATIN_PATTERN = /[A-Za-z]/g;

export function cjkCount(text) {
  return (String(text ?? '').match(CJK_PATTERN) || []).length;
}

export function latinCount(text) {
  return (String(text ?? '').match(LATIN_PATTERN) || []).length;
}

/** CJK 比 = 汉字数 / (汉字 + 拉丁字母)。 */
export function cjkRatio(text) {
  const zh = cjkCount(text);
  const en = latinCount(text);
  return zh / (zh + en || 1);
}

/** 去掉行首 Markdown 定界符与空白（`**`、反引号、`>`、`#`、`-` 等）。 */
export function stripDecorations(text) {
  return String(text ?? '').replace(/^[\s*_`>#\-]+/, '');
}

/** 取首个句末标点前内容；没有标点则取前 60 字符。中文标点后无需空格（v3 修正）。 */
export function firstSentence(text) {
  const cleaned = stripDecorations(text);
  const cjkStop = cleaned.match(/^[\s\S]*?[。！？]/);
  const latinStop = cleaned.match(/^[\s\S]*?\.(?=\s|$)/);
  const match = cjkStop ?? latinStop;
  const sentence = (match ? match[0] : cleaned.slice(0, 60)).trim();
  return sentence || cleaned.slice(0, 60).trim();
}

/**
 * 首句语言：'zh' | 'en' | 'other'。
 *
 * 实现与锚文本的两条判据**逐一对应**：
 *   ① 不得以 ASCII 字母开头 → 去装饰后首字符是 `[A-Za-z]` 直接判 en（优先于 CJK 计数）；
 *   ② 第一句必须包含中文字符 → CJK ≥1 且 CJK > 拉丁字母×0.5 才判 zh。
 * 这保证「判据文本」与「测量实现」不会各说各话：`OK 我先…`、`Sure 这一步…` 一律 en。
 */
export function firstSentenceLanguage(text) {
  const sentence = stripDecorations(firstSentence(text));
  // 主判据①（优先）：首字符是 ASCII 字母 → 一律不是中文首句（即便后面有汉字）。
  if (/^[A-Za-z]/.test(sentence)) return 'en';
  const zh = cjkCount(sentence);
  const en = latinCount(sentence);
  // 辅助判据：枚举不完备的正则，只在上面的主判据未命中时补充识别英文祈使起手。
  if (ENGLISH_IMPERATIVE.test(sentence)) return 'en';
  // 主判据②：第一句必须含中文字符（CJK ≥1 且 CJK > 拉丁字母×0.5）。
  if (zh >= 1 && zh > en * 0.5) return 'zh';
  if (en >= 3) return 'en';
  return 'other';
}

/**
 * 单段 reasoning 的完整指标：首句语言与整段 CJK 占比**分别给出**。
 * @param {string} text
 * @param {number} [index] 段序号（0-based）
 */
export function segmentMetrics(text, index = 0) {
  const value = String(text ?? '');
  const zh = cjkCount(value);
  const en = latinCount(value);
  const ratio = zh / (zh + en || 1);
  return {
    index,
    chars: value.length,
    cjk: zh,
    latin: en,
    cjkRatio: Number(ratio.toFixed(4)),
    firstSentence: firstSentence(value).slice(0, 40),
    firstLanguage: firstSentenceLanguage(value),
    // 两个指标分别标注，避免混用：首句是否中文 ≠ 整段是否中文主导。
    firstSentenceIsZh: firstSentenceLanguage(value) === 'zh',
    bodyIsZhDominant: ratio >= CJK_THRESHOLD,
  };
}

/** 会话是否属于长任务（字符数或段数任一超阈值）。 */
export function isLongTask({ chars = 0, segments = 0 } = {}) {
  return chars > LONG_TASK.chars || segments > LONG_TASK.segments;
}

/**
 * 按「长任务 / 短任务」分组汇总首句与整段两个指标。
 * @param {readonly {segments:number, chars:number, cjkRatio:number, firstLanguage:string}[]} rows
 */
export function summarizeLongTasks(rows) {
  const buckets = { long: [], short: [] };
  for (const row of rows ?? []) {
    (isLongTask(row) ? buckets.long : buckets.short).push(row);
  }
  const summarize = (list) => {
    const total = list.length;
    const firstEn = list.filter((row) => row.firstLanguage === 'en').length;
    const bodyEn = list.filter((row) => row.cjkRatio < CJK_THRESHOLD).length;
    const ratios = list.map((row) => row.cjkRatio).sort((a, b) => a - b);
    const median = ratios.length === 0 ? null : ratios[Math.floor(ratios.length / 2)];
    return {
      sessions: total,
      firstSentenceEn: firstEn,
      firstSentenceEnRate: Number((firstEn / (total || 1)).toFixed(4)),
      bodyEnDominant: bodyEn,
      bodyEnDominantRate: Number((bodyEn / (total || 1)).toFixed(4)),
      cjkRatioMedian: median === null ? null : Number(median.toFixed(4)),
    };
  };
  return { threshold: LONG_TASK, long: summarize(buckets.long), short: summarize(buckets.short) };
}
