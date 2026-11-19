#!/usr/bin/env node
/**
 * verify-installed — 检测当前 dsh profile 里 dsh-lang-rule 是否真的生效（只读）。
 *
 * 检查四层：
 *   A. 安装层：profile package.json 的 dependencies 与 dsh.profile.bundles 都引用了 dsh-lang-rule；
 *   B. 包层：插件目录存在 index.js / package.json / cordis.patch.yml，且版本与 v2 标记匹配；
 *   C. 注入层：最近会话的 system prompt 里能找到头锚与尾锚文本；
 *   D. 请求尾层：最近会话的 runtime-context 快照里能找到 per-request 约束（v2 新增，旧会话没有 → WARN）。
 *
 * 用法：
 *   node verify-installed.mjs                    # 默认 desktop profile、最近 10 个会话
 *   node verify-installed.mjs --profile web
 *   node verify-installed.mjs --json             # 机器可读
 *   node verify-installed.mjs --strict           # C/D 层没有会话证据也算失败
 *
 * 退出码：0 = 全部 PASS（WARN 不算失败）；1 = 存在 FAIL。
 * 只读：不写任何文件，不发消息。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { detectRequestTailEvidence, messageOf, messageText } from './lib/request-tail-detect.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const inline = argv.find((item) => item.startsWith(`${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const JSON_OUT = flag('--json');
const STRICT = flag('--strict');
const PROFILE = option('--profile', 'desktop');
const HOME = option('--home', process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
const LIMIT = Number(option('--limit', '10')) || 10;
const EXPLICIT_PLUGIN = option('--plugin', null);
const SESSION_FILTER = option('--session', null);

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const results = [];
const record = (name, status, detail) => {
  results.push({ name, status, detail });
  if (!JSON_OUT) {
    const mark = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️ ' : '❌';
    console.log(`${mark} ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

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

function loadEvents(dir) {
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

function recentSessionDirs(root, limit) {
  if (!fs.existsSync(root)) return [];
  const dirs = [];
  for (const workspace of fs.readdirSync(root)) {
    const workspaceDir = path.join(root, workspace);
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
      dirs.push({ full, name, mtime: fs.statSync(full).mtimeMs });
    }
  }
  return dirs.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

/** --plugin 相对路径：先按 cwd 解析；找不到 package.json 时回退按插件根（脚本上级目录）解析，避免在插件目录内执行时拼成 `<plugin>/<plugin>`。 */
function resolvePluginDir(value) {
  const fromCwd = path.resolve(value);
  if (fs.existsSync(path.join(fromCwd, 'package.json'))) return fromCwd;
  const fromScript = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', value);
  if (fs.existsSync(path.join(fromScript, 'package.json'))) return fromScript;
  return fromCwd;
}

// ── A. 安装层 ────────────────────────────────────────────────────────
const profileDir = path.join(HOME, 'profiles', PROFILE);
const profilePackage = path.join(profileDir, 'package.json');
let installedDir = null;
let pluginDir = EXPLICIT_PLUGIN ? resolvePluginDir(EXPLICIT_PLUGIN) : path.join(HOME, 'plugins', 'dsh-lang-rule');

/** 显式 --plugin 检查本地包时，profile 未安装只是 WARN（不阻断对包本身的验证）。 */
const recordProfile = (name, status, detail) => {
  record(name, status === 'FAIL' && EXPLICIT_PLUGIN !== null ? 'WARN' : status, detail);
};

if (!fs.existsSync(profilePackage)) {
  recordProfile(`profile 存在（${PROFILE}）`, 'FAIL', profilePackage);
} else {
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(profilePackage, 'utf8'));
  } catch (error) {
    recordProfile('profile package.json 可解析', 'FAIL', String(error.message));
  }
  if (pkg) {
    const dep = pkg.dependencies?.['dsh-lang-rule'];
    recordProfile('profile dependencies 引用 dsh-lang-rule', dep ? 'PASS' : 'FAIL', dep ?? '未找到');
    const bundles = pkg.dsh?.profile?.bundles ?? [];
    recordProfile('profile bundles 启用 dsh-lang-rule', bundles.includes('dsh-lang-rule') ? 'PASS' : 'FAIL', `bundles=${bundles.length}`);
    if (typeof dep === 'string' && dep.startsWith('file:')) {
      const resolved = path.resolve(profileDir, dep.slice('file:'.length));
      if (fs.existsSync(resolved)) installedDir = resolved;
      if (EXPLICIT_PLUGIN === null && installedDir !== null) pluginDir = installedDir;
    }
  }
}

// ── B. 包层 ──────────────────────────────────────────────────────────
const indexFile = path.join(pluginDir, 'index.js');
const pluginPackage = path.join(pluginDir, 'package.json');
const patchFile = path.join(pluginDir, 'cordis.patch.yml');

for (const [label, file] of [
  ['插件 index.js 存在', indexFile],
  ['插件 package.json 存在', pluginPackage],
  ['插件 cordis.patch.yml 存在', patchFile],
]) {
  record(label, fs.existsSync(file) ? 'PASS' : 'FAIL', file);
}

let pluginVersion = '?';
if (fs.existsSync(pluginPackage)) {
  try {
    pluginVersion = JSON.parse(fs.readFileSync(pluginPackage, 'utf8')).version ?? '?';
  } catch {
    pluginVersion = 'unparsable';
  }
}
record('插件版本', Number.parseInt(pluginVersion.split('.')[0], 10) >= 2 ? 'PASS' : 'WARN', pluginVersion);

if (fs.existsSync(indexFile)) {
  const source = fs.readFileSync(indexFile, 'utf8');
  record('index.js 含 v2+ 标记（requestTail / lang-rule:request-tail）',
    source.includes('requestTail') && source.includes('lang-rule:request-tail') ? 'PASS' : 'WARN',
    '旧版 v1 仍可用，但没有 per-request 通道');
}

// ── C/D. 注入层：最近会话证据 ────────────────────────────────────────
const sessionsRoot = path.join(HOME, 'sessions');
// v2 安装时间基准：index.js 的 mtime。晚于它的会话视为「v2 安装后的新会话」。
const pluginMtime = fs.existsSync(indexFile) ? fs.statSync(indexFile).mtimeMs : 0;
const allDirs = recentSessionDirs(sessionsRoot, SESSION_FILTER ? Number.POSITIVE_INFINITY : LIMIT);
const dirs = SESSION_FILTER === null ? allDirs : allDirs.filter((dir) => dir.name.includes(SESSION_FILTER)).slice(0, LIMIT);
if (dirs.length === 0) {
  record('会话证据', STRICT ? 'FAIL' : 'WARN', `未找到会话目录：${sessionsRoot}${SESSION_FILTER ? `（过滤 ${SESSION_FILTER}）` : ''}`);
} else {
  let headSeen = 0;
  let tailSeen = 0;
  let requestTailSeen = 0;
  let scanned = 0;
  let newScanned = 0;
  const requestTailSources = {};
  const requestTailDetails = [];
  for (const dir of dirs) {
    const events = loadEvents(dir.full);
    if (!events || events.length === 0) continue;
    scanned += 1;
    if (dir.mtime > pluginMtime) newScanned += 1;
    let systemText = '';
    for (const event of events) {
      if (event.type === 'system/message') systemText += `\n${messageText(messageOf(event))}`;
    }
    if (systemText.includes('语言铁律')) headSeen += 1;
    if (systemText.includes('第一句') && systemText.includes('简体中文')) tailSeen += 1;
    // D 层：per-request 尾约束证据。接受两种形态（source.kind=runtime-context 或 user 正文含判据词），
    // 避免旧版只读 data.message 导致的漏检。
    const evidence = detectRequestTailEvidence(events);
    if (evidence.found) {
      requestTailSeen += 1;
      requestTailSources[evidence.via] = (requestTailSources[evidence.via] ?? 0) + 1;
      if (requestTailDetails.length < 3) {
        requestTailDetails.push({
          session: dir.name,
          via: evidence.via,
          channel: evidence.channel,
          container: evidence.container,
          marker: evidence.marker,
          sectionNameSeen: evidence.sectionNameSeen,
          seq: evidence.seq,
          excerpt: evidence.excerpt,
        });
      }
    }
  }
  const fallback = STRICT ? 'FAIL' : 'WARN';
  record(`头锚出现在 system（${headSeen}/${scanned} 个会话）`, headSeen > 0 ? 'PASS' : fallback, `扫描 ${scanned} 个会话`);
  record(`尾锚出现在 system（${tailSeen}/${scanned} 个会话）`, tailSeen > 0 ? 'PASS' : fallback, `扫描 ${scanned} 个会话`);
  // 活体验收判据：v2 已装进 profile、且安装后已经产生新会话，就必须能看到 per-request 证据；
  // 严格模式判 FAIL。若检查的是未安装副本（--plugin 指向 work/），不做 FAIL 误判。
  const usingInstalled = installedDir !== null && path.resolve(installedDir) === path.resolve(pluginDir);
  const requestStatus = requestTailSeen > 0
    ? 'PASS'
    : newScanned > 0 && STRICT && usingInstalled
      ? 'FAIL'
      : 'WARN';
  const viaSummary = Object.entries(requestTailSources).map(([via, count]) => `${via}×${count}`).join(' / ');
  record(
    `per-request 约束出现在会话里（${requestTailSeen}/${scanned} 个会话；v2 安装后新会话 ${newScanned} 个）`,
    requestStatus,
    requestTailSeen > 0
      ? `语言约束请求尾通道已生效；来源 ${viaSummary}${requestTailDetails[0] ? `；样例 ${requestTailDetails[0].session} via=${requestTailDetails[0].via} channel=${requestTailDetails[0].channel ?? '?'} ${requestTailDetails[0].sectionNameSeen ? '命中 section=lang-rule:request-tail' : `marker=${requestTailDetails[0].marker}`}` : ''}`
      : !usingInstalled
        ? '当前检查的是未安装副本（--plugin），不做活体 FAIL 判定；装进 profile 后重跑'
        : newScanned > 0
          ? `v2 安装后的 ${newScanned} 个新会话里没有 context 证据，${STRICT ? '已判 FAIL' : '加 --strict 可判 FAIL'}`
          : '暂无 v2 安装后的新会话；新开一个会话后复测（此时 --strict 仅 WARN，不误判）',
  );
  if (requestTailDetails.length > 0) {
    for (const detail of requestTailDetails) {
      if (!JSON_OUT) console.log(`    · ${detail.session} via=${detail.via} channel=${detail.channel ?? '?'} container=${detail.container} seq=${detail.seq ?? '?'}${detail.sectionNameSeen ? ' section=lang-rule:request-tail' : ''} marker="${detail.marker ?? '-'}" ${detail.excerpt ?? ''}`);
    }
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────
const failed = results.filter((entry) => entry.status === 'FAIL');
const warned = results.filter((entry) => entry.status === 'WARN');
if (JSON_OUT) {
  console.log(JSON.stringify({
    meta: { profile: PROFILE, home: HOME, pluginDir, pluginVersion, scannedSessions: dirs.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    results,
  }, null, 2));
} else {
  console.log(`\n结论：${failed.length === 0 ? 'PASS' : 'FAIL'}（FAIL ${failed.length} / WARN ${warned.length} / 共 ${results.length} 项）`);
}
process.exit(failed.length === 0 ? 0 : 1);
