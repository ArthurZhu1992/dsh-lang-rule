#!/usr/bin/env node
/**
 * firststep-gate.mjs — first-step 前置门：读**落盘 user/message 原文**核对 step0 的 request-tail。
 *
 * 为什么不能用 provider 返回值：t61 曾用「provider 返回 first-step」判定 3/3，但落盘的是
 * refreshContext 的结果；t63 读原文发现 step0 实际是别的变体。本脚本只认持久化的会话原文。
 *
 * 判定（与 mid84-verdict 的 firstStep 核对同口径）：
 *   step0 = 第一个 `step/start` 之后、第二个 `step/start` 之前的 runtime-context 快照；
 *   step0Text = 该区间内**第一条** request-tail 文本；
 *   hit = step0Text 含「【首步】」且含「先读」且含「不得以 The user wants」（四类禁起手清单在场）。
 *
 * 用法：
 *   node tools/firststep-gate.mjs                        # 核对最近 5 条会话
 *   node tools/firststep-gate.mjs --batch <live-batch.json>  # 只核对批次里的会话
 *   node tools/firststep-gate.mjs --sessions-root <dir> --out out/firststep-gate.json
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const SESSIONS_ROOT = option('--sessions-root', path.join(PLUGIN_ROOT, '..', 'lang-rule-tests', '.runtime', 'dsh-home', 'sessions'));
const BATCH = option('--batch', null);
const OUT = path.resolve(option('--out', path.join(PLUGIN_ROOT, 'out', 'firststep-gate.json')));
const LIMIT = Number(option('--limit', '5')) || 5;
const FIRST_MARK = '【首步】';
const FORBIDDEN = ['不得以 The user wants', 'Need', 'I should', 'Let me'];
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

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
        /* skip */
      }
    }
    return parts.join('');
  } catch {
    return null;
  }
}

function tailTextOf(message) {
  const sections = message?.source?.sections;
  if (!Array.isArray(sections)) return null;
  const tail = sections.find((section) => /request-tail$/.test(String(section?.name ?? '')));
  return typeof tail?.text === 'string' ? tail.text : null;
}

/** step0 的第一条 request-tail（只读落盘原文）。 */
function step0TextOf(dir) {
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  if (!fs.existsSync(file)) return null;
  const raw = decompress(file);
  if (raw === null) return null;
  const events = raw.split('\n').filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
  let stepCount = 0;
  let seenFirstStep = false;
  for (const event of events) {
    if (event?.type === 'step/start') {
      stepCount += 1;
      seenFirstStep = stepCount === 1;
      continue;
    }
    if (!seenFirstStep) continue;
    if (event?.type !== 'user/message') continue;
    const message = event.data?.message ?? event.data;
    const text = tailTextOf(message);
    if (text !== null) return text;
  }
  return null;
}

function sessionDirs(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const ws of fs.readdirSync(root)) {
    const wsDir = path.join(root, ws);
    try {
      if (!fs.statSync(wsDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const name of fs.readdirSync(wsDir)) {
      const full = path.join(wsDir, name);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      out.push({ full, key: `${ws}/${name}`, mtime: fs.statSync(full).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

let targets;
if (BATCH !== null) {
  const data = JSON.parse(fs.readFileSync(path.resolve(BATCH), 'utf8'));
  const keys = (data.probes ?? []).filter((probe) => probe.ok && typeof probe.session === 'string').map((probe) => probe.session);
  targets = [...new Set(keys)].map((key) => ({ full: path.join(SESSIONS_ROOT, key), key, mtime: 0 }));
} else {
  targets = sessionDirs(SESSIONS_ROOT).slice(0, LIMIT);
}

const rows = [];
for (const target of targets) {
  const text = step0TextOf(target.full);
  if (text === null) {
    rows.push({ session: target.key, step0Text: null, hit: false, reason: 'no-step0-tail' });
    continue;
  }
  const hit = text.includes(FIRST_MARK) && text.includes('先读') && FORBIDDEN.every((word) => text.includes(word));
  rows.push({
    session: target.key,
    step0Text: text.slice(0, 80),
    hit,
    containsFirstMark: text.includes(FIRST_MARK),
    containsForbiddenList: FORBIDDEN.every((word) => text.includes(word)),
  });
}

const hits = rows.filter((row) => row.hit).length;
const result = {
  meta: {
    generatedAt: new Date().toISOString(),
    sessionsRoot: SESSIONS_ROOT,
    batch: BATCH,
    limit: BATCH === null ? LIMIT : null,
    method: '读落盘 user/message 原文：step0（第一个 step/start 之后）的第一条 request-tail；hit = 含【首步】+「先读」+四类禁起手清单。',
  },
  sessions: rows,
  hits,
  total: rows.length,
  hitRate: rows.length === 0 ? null : Number((hits / rows.length).toFixed(3)),
  pass: rows.length > 0 && hits === rows.length,
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

console.log(`first-step 前置门：${hits}/${rows.length} 命中（hitRate ${result.hitRate}）${result.pass ? ' PASS' : ' FAIL'}`);
for (const row of rows) {
  console.log(`  ${row.hit ? 'HIT ' : 'MISS'} ${row.session}  ${row.step0Text ?? row.reason}`);
}
console.log(`结果已写入 ${OUT}`);
process.exit(result.pass ? 0 : 1);
