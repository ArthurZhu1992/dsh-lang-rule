#!/usr/bin/env node
/**
 * measure-tool-variant.mjs — 测量「工具结果之后」变体的命中率（只读）。
 *
 * 背景（t37 实测）：旧实现只让「下一次 provider 调用」返回变体 2；若该 step 在 tool/result 后
 * 还有 refreshContext 调用，变体会在同一步被消费掉，下一个 step 已恢复轮换 —— long 会话命中率 1/3。
 * v3.1.3 把它提升为「下一个 step 整段使用」，命中率应接近 3/3。
 *
 * 用法：
 *   node tools/measure-tool-variant.mjs --simulate        # 机制模拟（默认），对照旧/新语义
 *   node tools/measure-tool-variant.mjs --session 2a6b3aee  # 读真实会话（旧实现实测基线）
 *   node tools/measure-tool-variant.mjs --replay --session 2a6b3aee  # 真实 step 序列 + 当前实现重放
 *   node tools/measure-tool-variant.mjs --json --out out/tool-variant.json
 *
 * ⚠️ 复现 `2a6b3aee` 必须带 `--sessions-root` 指向隔离 DSH_HOME：
 *   node tools/measure-tool-variant.mjs --replay \
 *     --sessions-root <harness-sessions-root>/.runtime/dsh-home/sessions \
 *     --session 2a6b3aee
 *   该会话只存在于隔离根；默认 `~/.dsh/sessions` 里没有它，会输出「未找到」。
 *   也可用环境变量 `DSH_SESSIONS_ROOT` 指定同一路径。
 *
 * 判定：对每个含 tool/result 的 step，检查**下一个 step** 的 runtime-context 里
 * `zh-yayan:request-tail` 文本是否含「工具结果之后」；命中率 = 命中数 / 检测数。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  REQUEST_VARIANTS,
  TOOL_RESULT_VARIANT_INDEX,
  createStepAwareVariantProvider,
} from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const JSON_OUT = flag('--json');
const REPLAY = flag('--replay');
const SIMULATE = !REPLAY && (flag('--simulate') || option('--session', null) === null);
const SESSION_FILTER = option('--session', null);
const OUT = path.resolve(option('--out', path.join(PLUGIN_ROOT, 'out', 'tool-variant.json')));
const SESSIONS_ROOT = option('--sessions-root', process.env.DSH_SESSIONS_ROOT || path.join(os.homedir(), '.dsh', 'sessions'));
const TOOL_MARK = '工具结果之后';
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

/** 把会话按 step 切段：返回 [{ hasToolResult, tailTexts[] }]。 */
function stepsOf(events) {
  const steps = [];
  let current = null;
  for (const event of events) {
    if (event?.type === 'step/start') {
      current = { hasToolResult: false, tailTexts: [] };
      steps.push(current);
      continue;
    }
    if (current === null) continue;
    if (event?.type === 'tool/result') {
      current.hasToolResult = true;
      continue;
    }
    if (event?.type === 'user/message') {
      const message = event.data?.message ?? event.data;
      const sections = message?.source?.sections;
      if (!Array.isArray(sections)) continue;
      const tail = sections.find((section) => section?.name === 'zh-yayan:request-tail');
      if (tail && typeof tail.text === 'string') current.tailTexts.push(tail.text);
    }
  }
  return steps;
}

/** 机制模拟：3 个 mid 场景（读 1 个文件 → 同 step 仍调用一次 → 下一步总结）。 */
function simulate() {
  const scenarios = [];
  for (let i = 0; i < 3; i += 1) {
    const tracker = createStepAwareVariantProvider({ mode: 'lazy', now: () => 0 });
    const sequence = [];
    tracker.noteStepStart(); // step A：读文件
    tracker.text({});
    tracker.noteToolResult(); // 工具结果
    tracker.text({}); // 同 step 的 refreshContext 调用（旧实现会在这里消费变体）
    tracker.noteStepStart(); // step B：总结
    sequence.push(REQUEST_VARIANTS.indexOf(tracker.text({})));
    sequence.push(REQUEST_VARIANTS.indexOf(tracker.text({}))); // 同 step 第二次调用
    scenarios.push({
      scenario: `mid-${i + 1}`,
      stepBVariants: sequence,
      hit: sequence.every((index) => index === TOOL_RESULT_VARIANT_INDEX),
    });
  }
  const hits = scenarios.filter((item) => item.hit).length;
  return {
    mode: 'simulate',
    scenarios,
    detected: scenarios.length,
    hits,
    hitRate: Number((hits / scenarios.length).toFixed(3)),
    legacyOneShot: { detected: 3, hits: 1, hitRate: 0.333, note: 't37 实测：旧实现只消费一次，命中 1/3' },
  };
}

/** 用真实会话的 step/tool 序列 + **当前实现**重放：给出修复后的预期命中率（不需部署）。 */
function replaySession(events, sessionName) {
  const steps = stepsOf(events);
  const tracker = createStepAwareVariantProvider({ mode: 'lazy', now: () => 0 });
  const results = [];
  for (let index = 0; index < steps.length; index += 1) {
    tracker.noteStepStart();
    const calls = Math.max(steps[index].tailTexts.length, 1);
    const variants = [];
    for (let call = 0; call < calls; call += 1) variants.push(REQUEST_VARIANTS.indexOf(tracker.text({})));
    // 该 step 的工具结果发生在调用之后（近似真实顺序：组装的尾部调用 → 工具执行）
    if (steps[index].hasToolResult) tracker.noteToolResult();
    results.push({ step: index, hasToolResult: steps[index].hasToolResult, variants });
  }
  const checks = [];
  for (let index = 0; index < results.length - 1; index += 1) {
    if (!results[index].hasToolResult) continue;
    const next = results[index + 1];
    checks.push({
      toolStep: index,
      nextStep: index + 1,
      variants: next.variants,
      hit: next.variants.length > 0 && next.variants.every((value) => value === TOOL_RESULT_VARIANT_INDEX),
    });
  }
  const hits = checks.filter((item) => item.hit).length;
  return {
    mode: 'replay',
    session: sessionName,
    detected: checks.length,
    hits,
    hitRate: checks.length === 0 ? null : Number((hits / checks.length).toFixed(3)),
    checks,
    note: '基于真实会话的 step/tool 序列 + v3.1.3 实现重放；真实宿主调用节奏下的命中率需部署后复测。',
  };
}

function observeSession() {
  const dirs = [];
  if (!fs.existsSync(SESSIONS_ROOT)) return null;
  for (const workspace of fs.readdirSync(SESSIONS_ROOT)) {
    const workspaceDir = path.join(SESSIONS_ROOT, workspace);
    try {
      if (!fs.statSync(workspaceDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const name of fs.readdirSync(workspaceDir)) {
      if (SESSION_FILTER !== null && !name.includes(SESSION_FILTER)) continue;
      const full = path.join(workspaceDir, name);
      try {
        if (!fs.statSync(full).isDirectory()) continue;
      } catch {
        continue;
      }
      dirs.push({ full, name, mtime: fs.statSync(full).mtimeMs });
    }
  }
  dirs.sort((a, b) => b.mtime - a.mtime);
  for (const dir of dirs.slice(0, 5)) {
    const events = loadEvents(dir.full);
    if (!events || events.length === 0) continue;
    if (REPLAY) return replaySession(events, dir.name);
    const steps = stepsOf(events);
    const checks = [];
    for (let index = 0; index < steps.length - 1; index += 1) {
      if (!steps[index].hasToolResult) continue;
      const next = steps[index + 1];
      if (next.tailTexts.length === 0) continue;
      checks.push({
        toolStep: index,
        nextStep: index + 1,
        hit: next.tailTexts.some((text) => text.includes(TOOL_MARK)),
        tailHead: next.tailTexts[0].slice(0, 40),
      });
    }
    if (checks.length === 0) continue;
    const hits = checks.filter((item) => item.hit).length;
    return {
      mode: 'session',
      session: dir.name,
      detected: checks.length,
      hits,
      hitRate: Number((hits / checks.length).toFixed(3)),
      checks,
    };
  }
  return null;
}

const result = SIMULATE ? simulate() : observeSession();
const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    sessionFilter: SESSION_FILTER,
    sessionsRoot: SESSIONS_ROOT,
    note: '对每个含 tool/result 的 step，检查下一个 step 的 request-tail 文本是否含「工具结果之后」。',
  },
  ...(result ?? { mode: 'session', session: null, detected: 0, hits: 0, hitRate: null, checks: [] }),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

if (JSON_OUT) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  if (payload.mode === 'simulate') {
    console.log(`机制模拟：${payload.hits}/${payload.detected} 命中（hitRate ${payload.hitRate}）`);
    for (const item of payload.scenarios) {
      console.log(`  ${item.scenario}: stepB 变体 ${JSON.stringify(item.stepBVariants)} → ${item.hit ? 'HIT' : 'MISS'}`);
    }
    console.log('对照：t37 实测旧实现（一次性消费）命中 1/3');
  } else if (payload.mode === 'replay') {
    console.log(`重放会话 ${payload.session}（v3.1.3 实现）：${payload.hits}/${payload.detected} 命中（hitRate ${payload.hitRate}）`);
    for (const item of payload.checks) {
      console.log(`  toolStep ${item.toolStep} → nextStep ${item.nextStep}: 变体 ${JSON.stringify(item.variants)} → ${item.hit ? 'HIT' : 'MISS'}`);
    }
  } else if (payload.session) {
    console.log(`会话 ${payload.session}（旧实现实测）：${payload.hits}/${payload.detected} 命中（hitRate ${payload.hitRate}）`);
  } else {
    console.log('未找到含 tool/result 的会话；用 --simulate 看机制模拟。');
  }
  console.log(`结果已写入 ${OUT}`);
}
