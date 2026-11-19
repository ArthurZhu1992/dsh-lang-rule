#!/usr/bin/env node
/**
 * measure-appends.mjs — 测量 per-request 约束在真实会话里的 append/step，并给出三档预测。
 *
 * 背景（t24 实测）：v3.1 的 lazy 按「provider 调用次数」计数，但宿主在一个 step 内可能多次调用
 * provider（preStep assemble + step 内 refreshContext + 重试），导致 lazy 被放大：
 * long 组 append/step = 0.783，而设计预期是 0.33。v3.1.1 改为按 step 计数。
 *
 * 用法：
 *   node tools/measure-appends.mjs                 # 读最近一个含 runtime-context 的会话（只读）
 *   node tools/measure-appends.mjs --session 03d5a353
 *   node tools/measure-appends.mjs --dry-run       # 不读会话，只跑 20 step 的机制模拟
 *   node tools/measure-appends.mjs --out out/appends.json --json
 *
 * 输出：append 次数 / step 数 / append-per-step，以及 off / lazy / step 三档模拟值；
 * 结果默认落盘到 out/appends.json（--out 可改）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  REQUEST_VARIANTS,
  REQUEST_TEXT,
  createStepAwareVariantProvider,
  estimateTokens,
} from '../index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const DRY_RUN = flag('--dry-run');
const JSON_OUT = flag('--json');
const SESSION_FILTER = option('--session', null);
const OUT = path.resolve(option('--out', path.join(PLUGIN_ROOT, 'out', 'appends.json')));
const SESSIONS_ROOT = option('--sessions-root', process.env.DSH_SESSIONS_ROOT || path.join(os.homedir(), '.dsh', 'sessions'));
const STEPS = Number(option('--steps', '20')) || 20;
const CALLS_PER_STEP = Number(option('--calls-per-step', '2')) || 2;

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

function recentDirs(limit = 20) {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const dirs = [];
  for (const workspace of fs.readdirSync(SESSIONS_ROOT)) {
    const workspaceDir = path.join(SESSIONS_ROOT, workspace);
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

/** 统一个会话：step 数、runtime-context append 次数。 */
function observe(events) {
  let steps = 0;
  let appends = 0;
  for (const event of events) {
    if (event?.type === 'step/start') steps += 1;
    if (event?.type === 'user/message') {
      const message = event.data?.message ?? event.data;
      const sections = message?.source?.sections;
      const isRequestTail = Array.isArray(sections) && sections.some((section) => section?.name === 'lang-rule:request-tail');
      if (message?.source?.kind === 'runtime-context' && isRequestTail) appends += 1;
    }
  }
  return { steps, appends, appendPerStep: steps === 0 ? null : Number((appends / steps).toFixed(3)) };
}

/** 模拟某模式在 steps × callsPerStep 下的 append 次数（文本变化即一次 append，等同宿主整包去重）。 */
function simulate(mode, steps, callsPerStep) {
  let previous = null;
  let appends = 0;
  if (mode === 'off') {
    for (let step = 0; step < steps; step += 1) {
      for (let call = 0; call < callsPerStep; call += 1) {
        if (previous !== REQUEST_TEXT) {
          appends += 1;
          previous = REQUEST_TEXT;
        }
      }
    }
    return { appends, appendPerStep: Number((appends / steps).toFixed(3)) };
  }
  const tracker = createStepAwareVariantProvider({ mode, variants: REQUEST_VARIANTS });
  for (let step = 0; step < steps; step += 1) {
    tracker.noteStepStart();
    for (let call = 0; call < callsPerStep; call += 1) {
      const text = tracker.text({});
      if (text !== previous) {
        appends += 1;
        previous = text;
      }
    }
  }
  return { appends, appendPerStep: Number((appends / steps).toFixed(3)) };
}

const observed = (() => {
  if (DRY_RUN) return null;
  const dirs = SESSION_FILTER ? recentDirs(200).filter((dir) => dir.name.includes(SESSION_FILTER)) : recentDirs(20);
  for (const dir of dirs) {
    const events = loadEvents(dir.full);
    if (!events || events.length === 0) continue;
    const stats = observe(events);
    if (stats.steps === 0) continue;
    return { session: dir.name, ...stats };
  }
  return null;
})();

const simulated = {
  steps: STEPS,
  callsPerStep: CALLS_PER_STEP,
  off: simulate('off', STEPS, CALLS_PER_STEP),
  lazy: simulate('lazy', STEPS, CALLS_PER_STEP),
  step: simulate('step', STEPS, CALLS_PER_STEP),
};

const result = {
  meta: {
    generatedAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    sessionsRoot: SESSIONS_ROOT,
    session: observed?.session ?? null,
    note: 'append = 宿主 runtime-context 快照实际新增次数（文本不变时整包去重跳过）；appendPerStep = appends / step。',
  },
  observed,
  simulated,
  tokens: {
    requestText: estimateTokens(REQUEST_TEXT),
    variants: REQUEST_VARIANTS.map((text) => estimateTokens(text)),
  },
  theory: {
    baselineV311BeforeFix: 0.783,
    note: 't24 实测 long 组修复前 append/step=0.783（按 provider 调用计数被放大）；修复后 lazy 应按 step 计数。',
  },
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

if (JSON_OUT) {
  console.log(JSON.stringify(result, null, 2));
} else {
  if (observed) {
    console.log(`实测会话 ${observed.session}：step ${observed.steps} / append ${observed.appends} / append-per-step ${observed.appendPerStep}`);
  } else {
    console.log('未读取会话（--dry-run 或未找到含 step 的会话）；只输出模拟值。');
  }
  console.log(`模拟 ${STEPS} step × ${CALLS_PER_STEP} 次 provider 调用：`);
  for (const mode of ['off', 'lazy', 'step']) {
    const value = simulated[mode];
    console.log(`  ${mode}: append ${value.appends} 次 / append-per-step ${value.appendPerStep}`);
  }
  console.log(`修复前 t24 实测 long 组 append-per-step = 0.783（按调用计数被放大）`);
  console.log(`结果已写入 ${OUT}`);
}
