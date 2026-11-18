/**
 * lang-audit — 语言策略复测工具（只读）。
 *
 * 用法：
 *   node lang-audit.mjs                 扫描最近 40 个会话
 *   node lang-audit.mjs <session-id>    只看指定会话及其子会话
 *
 * 输出每个会话的 reasoning 中文占比与首句语言。只读会话文件，不发送任何消息。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// 会话目录可移植化：优先 DSH_SESSIONS_ROOT，其次 ~/.dsh/sessions。
const SESSIONS_ROOT =
  process.env.DSH_SESSIONS_ROOT || path.join(os.homedir(), '.dsh', 'sessions');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompress(file) {
  const buf = fs.readFileSync(file);
  const cuts = [];
  let i = 0;
  for (;;) {
    const k = buf.indexOf(MAGIC, i);
    if (k < 0) break;
    cuts.push(k);
    i = k + 4;
  }
  cuts.push(buf.length);
  const parts = [];
  for (let n = 0; n < cuts.length - 1; n++) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(cuts[n], cuts[n + 1])).toString('utf8'));
    } catch {
      /* 跳过坏帧 */
    }
  }
  return parts.join('');
}

function loadSession(dir) {
  const fp = path.join(dir, 'session.v4.jsonl.zstd');
  if (!fs.existsSync(fp)) return null;
  const events = decompress(fp)
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
  return events;
}

const cjk = (s) => (s.match(/[\u4e00-\u9fff]/g) || []).length;
const latin = (s) => (s.match(/[A-Za-z]/g) || []).length;
const firstClause = (t) => (t.split(/[。！？\n]|\.\s/)[0] || '').trim();

function stats(events) {
  const reasoning = [];
  for (const e of events) {
    if (e.type !== 'assistant/message') continue;
    for (const c of e.data?.message?.content || []) {
      if (c.type === 'reasoning' && c.text) reasoning.push(c.text);
    }
  }
  if (!reasoning.length) return null;
  const all = reasoning.join('\n');
  const cz = cjk(all);
  const en = latin(all);
  const sys = events.find((e) => e.type === 'system/message');
  const sysText = JSON.stringify(sys?.data || '');
  return {
    segments: reasoning.length,
    ratio: cz / (cz + en || 1),
    firstZh: cjk(firstClause(reasoning[0])) > 1,
    hasRule: sysText.includes('语言铁律'),
    hasTail: sysText.includes('本步语言要求'),
  };
}

function listDirs() {
  if (!fs.existsSync(SESSIONS_ROOT)) {
    console.error(`找不到会话目录：${SESSIONS_ROOT}`);
    console.error('请用 DSH_SESSIONS_ROOT 指向 DSH 会话目录后重试。');
    process.exit(2);
  }
  const dirs = [];
  for (const ws of fs.readdirSync(SESSIONS_ROOT)) {
    const wsDir = path.join(SESSIONS_ROOT, ws);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const d of fs.readdirSync(wsDir)) {
      const full = path.join(wsDir, d);
      if (!fs.statSync(full).isDirectory()) continue;
      dirs.push({ full, name: d, mtime: fs.statSync(full).mtimeMs });
    }
  }
  return dirs.sort((a, b) => b.mtime - a.mtime);
}

const target = process.argv[2];
const dirs = listDirs().filter((d) => (target ? d.name.includes(target) : true)).slice(0, target ? 1 : 40);

let zh = 0;
let en = 0;
for (const d of dirs) {
  const events = loadSession(d.full);
  if (!events) continue;
  const main = events.find((e) => e.type === 'session');
  const self = stats(events);
  if (!self) continue;
  const isChild = !d.name.startsWith('session-');
  const mark = self.ratio >= 0.2 ? '中' : '英';
  if (self.ratio >= 0.2) zh += 1;
  else en += 1;
  console.log(
    `${mark} ${d.name.slice(0, 24).padEnd(24)} ${isChild ? '子' : '主'} 段=${String(self.segments).padStart(3)} 比=${self.ratio.toFixed(2)} 首句=${self.firstZh ? '中' : '英'} 铁律=${self.hasRule ? 'Y' : 'N'} 尾锚=${self.hasTail ? 'Y' : 'N'} preset=${main?.agentPreset || '?'}`,
  );
  const kids = events.filter((e) => e.type === 'subagent/catalog').map((e) => e.data);
  for (const k of kids) {
    const kidDir = path.join(path.dirname(d.full), k.childId);
    const kidEvents = loadSession(kidDir);
    if (!kidEvents) continue;
    const s = stats(kidEvents);
    if (!s) continue;
    const km = s.ratio >= 0.2 ? '中' : '英';
    if (s.ratio >= 0.2) zh += 1;
    else en += 1;
    console.log(
      `  ${km}   ↳ ${(k.label || '').split(':').pop().padEnd(20)} 段=${String(s.segments).padStart(3)} 比=${s.ratio.toFixed(2)} 首句=${s.firstZh ? '中' : '英'} 尾锚=${s.hasTail ? 'Y' : 'N'}`,
    );
  }
}
console.log(`\n汇总：中文主导 ${zh} / 英文主导 ${en}`);
