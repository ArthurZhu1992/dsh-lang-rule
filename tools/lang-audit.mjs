#!/usr/bin/env node
/**
 * lang-audit v2 — 语言策略复测工具（只读，无网络依赖）。
 *
 * v2 相比 v1 增加：
 *   1. --json 机器可读输出（含 meta / summary / sessions 三段），可直接喂给 harness；
 *   2. 逐段首句语言统计：每个 reasoning 段单独算 CJK 比与首句语言，并给出
 *      「首个英文段」序号与连续英文区间 —— 能看出是哪一步开始跑英文；
 *   3. 按锚阶段分层（noanchor / head / head+tail / head+tail+request）统计英文主导率与首句英文率，
 *      与 t3 验收判据对齐（head+tail+request：英文主导 <3%、首句英文 <5%）；
 *   4. 识别 v2 的 per-request 通道证据（runtime-context 快照里的首句约束）。
 *
 * 首句判定口径（与 gate-reviewer 纠偏一致）：
 *   去掉行首 Markdown 定界符与空白 → 取首个句末标点前内容 → 若 CJK ≥1 且 CJK > 拉丁字母×0.5，
 *   且不以英文祈使句（Let me / Let's / I'll / We need to / The user wants …）开头，判为中文首句。
 *
 * 用法：
 *   node lang-audit.mjs                       扫描最近 40 个会话
 *   node lang-audit.mjs --limit 200           扫描最近 200 个
 *   node lang-audit.mjs --all                 扫描全部
 *   node lang-audit.mjs <session-id>          只看匹配的会话及其子会话
 *   node lang-audit.mjs --json                JSON 输出（含逐段明细）
 *   node lang-audit.mjs --json --no-segments   JSON 输出但不含逐段明细
 *   node lang-audit.mjs --root <path>         指定 sessions 根目录
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  CJK_THRESHOLD,
  cjkCount as cjk,
  latinCount as latin,
  firstSentence,
  firstSentenceLanguage,
  isLongTask,
  LONG_TASK,
  summarizeLongTasks,
} from './lib/lang-metrics.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};
const positional = argv.filter((item, index) => !item.startsWith('--') && !argv[index - 1]?.startsWith('--'));

const JSON_OUT = flag('--json');
const WITH_SEGMENTS = !flag('--no-segments');
const ROOT = option('--root', process.env.DSH_SESSIONS_ROOT || path.join(os.homedir(), '.dsh', 'sessions'));
const TARGET = positional[0];
const LIMIT = flag('--all') ? Number.POSITIVE_INFINITY : (Number(option('--limit', TARGET ? '1' : '40')) || 40);

function decompress(file) {
  try {
    const buf = fs.readFileSync(file);
    const cuts = [];
    let index = 0;
    for (;;) {
      const at = buf.indexOf(MAGIC, index);
      if (at < 0) break;
      cuts.push(at);
      index = at + 4;
    }
    if (cuts.length === 0) return null;
    cuts.push(buf.length);
    const parts = [];
    for (let n = 0; n < cuts.length - 1; n += 1) {
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(cuts[n], cuts[n + 1])).toString('utf8'));
      } catch {
        /* 跳过坏帧 */
      }
    }
    return parts.join('');
  } catch {
    return null;
  }
}

function loadSession(dir) {
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  if (!fs.existsSync(file)) return null;
  const text = decompress(file);
  if (text === null) return null;
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function textOf(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block?.type === 'text' ? block.text : ''))
    .filter(Boolean)
    .join('\n');
}

/** 把一个会话的事件拆成 reasoning 段，并逐段算语言指标。 */
function analyze(events) {
  const segments = [];
  let systemText = '';
  let runtimeContextText = '';
  let firstUser = null;
  let sessionEvent = null;

  for (const event of events) {
    if (event.type === 'session') sessionEvent = event.data;
    if (event.type === 'system/message') systemText += `\n${textOf(event.data?.message)}`;
    if (event.type === 'user/message') {
      const message = event.data?.message;
      if (firstUser === null) firstUser = message;
      if (message?.source?.kind === 'runtime-context') runtimeContextText += `\n${textOf(message)}`;
    }
    if (event.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.trim() !== '') {
          const text = block.text;
          const zh = cjk(text);
          const en = latin(text);
          const language = firstSentenceLanguage(text);
          segments.push({
            index: segments.length,
            chars: text.length,
            cjk: zh,
            latin: en,
            cjkRatio: Number((zh / (zh + en || 1)).toFixed(4)),
            firstLanguage: language,
            firstSentence: firstSentence(text).slice(0, 40),
          });
        }
      }
    }
  }

  if (segments.length === 0) return null;

  const totalCjk = segments.reduce((sum, segment) => sum + segment.cjk, 0);
  const totalLatin = segments.reduce((sum, segment) => sum + segment.latin, 0);
  const cjkRatio = Number((totalCjk / (totalCjk + totalLatin || 1)).toFixed(4));
  const dominant = cjkRatio >= CJK_THRESHOLD ? 'zh' : 'en';

  // 英文段连续区间 + 首个英文段（「哪一步开始跑英文」）。
  const runs = [];
  let runStart = null;
  for (const segment of segments) {
    if (segment.firstLanguage === 'en') {
      if (runStart === null) runStart = segment.index;
    } else if (runStart !== null) {
      runs.push([runStart, segment.index - 1]);
      runStart = null;
    }
  }
  if (runStart !== null) runs.push([runStart, segments.length - 1]);
  const firstEnSegment = segments.find((segment) => segment.firstLanguage === 'en')?.index ?? null;

  const hasHead = systemText.includes('语言铁律');
  const hasTail = systemText.includes('第一句') && systemText.includes('简体中文');
  const hasRequestTail = runtimeContextText.includes('第一句') && runtimeContextText.includes('简体中文');
  const layer = !hasHead && !hasTail ? 'noanchor' : hasHead && !hasTail ? 'head' : hasTail && !hasRequestTail ? 'head+tail' : 'head+tail+request';

  return {
    segments: segments.length,
    chars: segments.reduce((sum, segment) => sum + segment.chars, 0),
    cjkRatio,
    dominant,
    firstLanguage: segments[0].firstLanguage,
    firstSentence: segments[0].firstSentence,
    firstEnSegment,
    firstEnAt: firstEnSegment === null ? null : Number((firstEnSegment / segments.length).toFixed(3)),
    enRuns: runs,
    anchors: { head: hasHead, tail: hasTail, requestTail: hasRequestTail, layer },
    preset: sessionEvent?.agentPreset ?? firstUser?.source?.kind ?? '?',
    raw: WITH_SEGMENTS ? segments : undefined,
  };
}

function listDirs() {
  if (!fs.existsSync(ROOT)) return [];
  const dirs = [];
  for (const workspace of fs.readdirSync(ROOT)) {
    const workspaceDir = path.join(ROOT, workspace);
    let stat;
    try {
      stat = fs.statSync(workspaceDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const name of fs.readdirSync(workspaceDir)) {
      const full = path.join(workspaceDir, name);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      dirs.push({ full, name, workspace, mtime: fs.statSync(full).mtimeMs, isChild: !name.startsWith('session-') });
    }
  }
  return dirs;
}

/** 会话 + 其 catalog 子会话的扁平列表。 */
function collect() {
  const dirs = listDirs().sort((a, b) => b.mtime - a.mtime);
  if (TARGET) {
    return dirs.filter((dir) => dir.name.includes(TARGET));
  }
  return dirs.slice(0, LIMIT === Number.POSITIVE_INFINITY ? dirs.length : LIMIT);
}

const loaded = [];
for (const dir of collect()) {
  const events = loadSession(dir.full);
  if (!events) continue;
  loaded.push({ dir, events });
}

// 子会话既是独立目录，也会出现在父会话的 subagent/catalog 里；先扫 catalog 建索引，再按
// 「父会话优先」排序 + seen 去重，避免同一会话被统计两次。
const childIds = new Set();
for (const entry of loaded) {
  for (const event of entry.events) {
    if (event.type === 'subagent/catalog' && typeof event.data?.childId === 'string') childIds.add(event.data.childId);
  }
}
const ordered = [
  ...loaded.filter((entry) => !childIds.has(entry.dir.name)),
  ...loaded.filter((entry) => childIds.has(entry.dir.name)),
];

const rows = [];
const seen = new Set();
for (const { dir, events } of ordered) {
  if (seen.has(dir.name)) continue;
  const analysis = analyze(events);
  if (!analysis) continue;
  seen.add(dir.name);
  rows.push({ name: dir.name, workspace: dir.workspace, role: dir.isChild ? '子' : '主', ...analysis });

  for (const event of events) {
    if (event.type !== 'subagent/catalog') continue;
    const childId = event.data?.childId;
    if (typeof childId !== 'string' || seen.has(childId)) continue;
    const childDir = path.join(path.dirname(dir.full), childId);
    const childEvents = loadSession(childDir);
    if (!childEvents) continue;
    const childAnalysis = analyze(childEvents);
    if (!childAnalysis) continue;
    seen.add(childId);
    rows.push({
      name: childId,
      workspace: dir.workspace,
      role: '子',
      label: event.data?.label ?? '',
      ...childAnalysis,
    });
  }
}

const layerOrder = ['noanchor', 'head', 'head+tail', 'head+tail+request'];
const layers = new Map(layerOrder.map((layer) => [layer, { layer, sessions: 0, enDominant: 0, firstEn: 0 }]));
for (const row of rows) {
  const bucket = layers.get(row.anchors.layer);
  bucket.sessions += 1;
  if (row.dominant === 'en') bucket.enDominant += 1;
  if (row.firstLanguage === 'en') bucket.firstEn += 1;
}
const byLayer = layerOrder
  .map((layer) => layers.get(layer))
  .filter((bucket) => bucket.sessions > 0)
  .map((bucket) => ({
    layer: bucket.layer,
    sessions: bucket.sessions,
    enDominant: bucket.enDominant,
    enDominantRate: Number((bucket.enDominant / bucket.sessions).toFixed(4)),
    firstSentenceEn: bucket.firstEn,
    firstSentenceEnRate: Number((bucket.firstEn / bucket.sessions).toFixed(4)),
  }));

const total = rows.length;
const enDominant = rows.filter((row) => row.dominant === 'en').length;
const firstEn = rows.filter((row) => row.firstLanguage === 'en').length;
const firstEnSegments = rows.map((row) => row.firstEnSegment).filter((value) => value !== null).sort((a, b) => a - b);
const median = firstEnSegments.length === 0
  ? null
  : firstEnSegments[Math.floor(firstEnSegments.length / 2)];

const summary = {
  sessions: total,
  zhDominant: total - enDominant,
  enDominant,
  enDominantRate: Number((enDominant / (total || 1)).toFixed(4)),
  firstSentenceEn: firstEn,
  firstSentenceEnRate: Number((firstEn / (total || 1)).toFixed(4)),
  firstEnSegmentMedian: median,
  byAnchorLayer: byLayer,
  // v3：首句语言与整段 CJK 是两个独立指标，这里给出交叉分布与长任务分组。
  firstSentenceVsBody: {
    note: '首句中文但整段英文主导 —— 说明「首句中文 ≠ 整段中文」，长任务会被稀释',
    firstZhBodyEn: rows.filter((row) => row.firstLanguage === 'zh' && row.dominant === 'en').length,
    firstEnBodyZh: rows.filter((row) => row.firstLanguage === 'en' && row.dominant === 'zh').length,
  },
  longTasks: summarizeLongTasks(rows),
  longTaskThreshold: LONG_TASK,
};

if (JSON_OUT) {
  console.log(JSON.stringify({
    meta: {
      root: ROOT,
      generatedAt: new Date().toISOString(),
      node: process.version,
      limit: LIMIT === Number.POSITIVE_INFINITY ? 'all' : LIMIT,
      sessionFilter: TARGET ?? null,
      policy: { cjkThreshold: CJK_THRESHOLD, firstSentence: 'strip-decorations + first punctuation + CJK>=1 & CJK>latin*0.5 & not imperative' },
      segmentsIncluded: WITH_SEGMENTS,
    },
    summary,
    sessions: rows,
  }, null, 2));
} else {
  for (const row of rows) {
    const mark = row.dominant === 'zh' ? '中' : '英';
    const pad = (value, width) => String(value).padEnd(width);
    const layer = row.anchors.layer.padEnd(18);
    console.log(
      `${mark} ${pad(row.name.slice(0, 36), 36)} ${row.role} 段=${String(row.segments).padStart(3)} 比=${row.cjkRatio.toFixed(2)} 首句=${row.firstLanguage === 'zh' ? '中' : row.firstLanguage === 'en' ? '英' : '?'} 首个英段=${row.firstEnSegment === null ? '-' : row.firstEnSegment} ${layer} 尾锚=${row.anchors.tail ? 'Y' : 'N'} 请求尾=${row.anchors.requestTail ? 'Y' : 'N'} preset=${row.preset}`,
    );
    if (flag('--verbose')) {
      for (const segment of row.raw ?? []) {
        console.log(`     seg ${String(segment.index).padStart(3)} ${segment.firstLanguage} 比=${segment.cjkRatio.toFixed(2)} ${segment.firstSentence}`);
      }
    }
  }
  console.log('\n按锚阶段分层：');
  for (const bucket of byLayer) {
    console.log(`  ${bucket.layer.padEnd(20)} 会话 ${String(bucket.sessions).padStart(4)}  英文主导 ${(bucket.enDominantRate * 100).toFixed(1)}%  首句英文 ${(bucket.firstSentenceEnRate * 100).toFixed(1)}%`);
  }
  console.log(`\n汇总：会话 ${summary.sessions} / 中文主导 ${summary.zhDominant} / 英文主导 ${summary.enDominant}（${(summary.enDominantRate * 100).toFixed(1)}%）/ 首句英文 ${summary.firstSentenceEn}（${(summary.firstSentenceEnRate * 100).toFixed(1)}%）/ 首个英文段序号中位数 ${summary.firstEnSegmentMedian ?? '-'}`);
  const long = summary.longTasks.long;
  const short = summary.longTasks.short;
  console.log(`首句 vs 整段（两个独立指标）：首句中文但整段英文主导 ${summary.firstSentenceVsBody.firstZhBodyEn} 个；首句英文但整段中文主导 ${summary.firstSentenceVsBody.firstEnBodyZh} 个`);
  console.log(`长任务分组（>${LONG_TASK.chars} 字符或 >${LONG_TASK.segments} 段）：${long.sessions} 个 → 首句英文 ${(long.firstSentenceEnRate * 100).toFixed(1)}% / 整段英文主导 ${(long.bodyEnDominantRate * 100).toFixed(1)}% / CJK 中位数 ${long.cjkRatioMedian ?? '-'}`);
  console.log(`短任务分组：${short.sessions} 个 → 首句英文 ${(short.firstSentenceEnRate * 100).toFixed(1)}% / 整段英文主导 ${(short.bodyEnDominantRate * 100).toFixed(1)}% / CJK 中位数 ${short.cjkRatioMedian ?? '-'}`);
}
