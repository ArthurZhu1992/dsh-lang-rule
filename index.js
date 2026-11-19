/**
 * dsh-lang-rule v3 — 部署级语言策略插件。
 *
 * 目标（由全量语料审计 LANG-AUDIT 定位）：
 *   1. 首句是唯一强预测因子：首句英文 → 整段英文 81.1%，首句中文 → 1.1%；
 *   2. v1 的 head+tail 已把英文主导率从 39.7% 压到 13.4%，再加长尾锚边际收益极低；
 *   3. 真正漏点在「请求内部」：system 之后还压着 15.6–16.7 KB user 文本，尾锚在 system 里
 *      只能保证「system 段内最后」，保证不了「请求最后」。
 *
 * 五处注入（order 与 v2.0.0/2.0.1 完全一致，v3 不新增通道）：
 *
 *   [section] order -900   头部铁律锚      长版定性，紧跟 harness 身份段
 *   [section] order -880   子智能体强化锚  显式点名 subagent / AgentTeams / workflow / 后台任务
 *   [section] order 5100   工具文档后重申  在工具 schema 之后、结构化输出之前补一次短约束
 *   [section] order 90050  尾部首句锚      排在全部宿主 section 之后（宿主上界 10200）
 *   [context] order 500    请求尾上下文    宿主每次请求重新渲染，快照 append 在 claimed 消息之后
 *
 * v3 相对 v2 的三处改造（只改文本与 context provider，不改注入机制）：
 *   ① 判据换轨：从「禁止若干英文短语」改为**可判定**——第一句必须包含中文字符、不得以 ASCII 字母开头；
 *      黑名单降级为辅助提示，并在文档写明「枚举永远不完备」（实测 `The user wants` / `The task:` 漏网）。
 *   ② few-shot：给 2 个极短中文首句正确示范，让模型有可模仿的形状。
 *   ③ step 级变体：context 文本不再固定，按 step 在 3 个变体间轮换。原因：宿主对 runtime-context
 *      的判重单位是整包 sections，固定文本只会 append 一次，长任务（工具调用多）约束被稀释。
 *
 * 顺序依据（非推测，读自 dsh 0.2.2-rc.3 的 @deepseek-ai/dsh-system-prompt src/index.ts）：
 *   SECTION_ORDERS 上界 = DEPLOYMENT_PERSONA_SUFFIX 10200，宿主 section 全部 ≤ 10200；
 *   CONTEXT_ORDERS 上界 = WEB_SURFACE 210，宿主 context 全部 ≤ 210。
 *   本插件在运行时用 registry.getSectionOrder() / getContextOrder() 探测这两个上界，
 *   取「宿主上界 + 安全余量」，探测不到时回退到实测常量。所以 order 可解释、可随宿主演进自适应。
 *
 * 抗升级设计（沿用 v1 并加强）：
 *   - 不 import 任何 cordis / dsh 内部模块，只使用 ctx 暴露的服务；
 *   - systemPrompt 服务缺失、section()/context() 抛错、logger 缺失，一律静默降级，绝不阻断 dsh 启动；
 *   - 同名 section 已被占用时让出，继续注册其余锚；
 *   - per-request 通道不可用时进入 degraded 模式（仅 system 四锚），并在日志 debug 级说明。
 *
 * 回归开关：config.requestTail = 'off' 时完全不注册 context，行为回到 v1 的纯 section 版本；
 * config.contextVariant = false 时 context 文本固定（等同 v2 行为，便于基线对比）；
 * config.enabled = false 时整插件不注册任何东西。
 */

export const name = 'lang-rule';

/** 等 system-prompt 注册表就绪后再贡献锚点。 */
export const inject = ['systemPrompt'];

// ── 文本（长度预算：头 ≤250 / 子智能体 ≤60 / mid ≤150 / 尾 ≤80 / 请求尾 ≤150 字符；v3 few-shot 总长 ≤60） ──

/** 头部铁律：长版定性。去掉 v1 里归子智能体锚负责的那一条，避免重复计费。 */
export const HEAD_TEXT = [
  '**语言铁律（部署级策略，优先于本提示其余一切英文表述）**',
  '- 所有内部推理（thinking / reasoning）与所有可见输出，一律使用简体中文；不得用英文思考。',
  '- 计划、执行摘要、评审结论、错误说明一律中文；仅代码、命令、路径、API 名、报错原文保持英文。',
  '- 唯一例外：用户明确要求改用其他语言。',
].join('\n');

/** 子智能体强化锚：证据显示漏网的全是子会话（首句英文 32.5% vs 主会话 10.9%）。 */
export const SUBAGENT_TEXT =
  '子智能体、AgentTeams 成员、workflow 子智能体、后台任务：铁律同样强制，委派词与产出全中文。';

/** 工具文档之后的重申句（order 5100，位于工具 schema 与结构化输出之间）。v3：同步为可判定判据。 */
export const MID_TEXT =
  '语言重申：reasoning 用简体中文；第一句必须包含中文字符、不得以 ASCII 字母开头；辅助提示（枚举永远不完备）：Let me / The user wants / The task: 都不算中文首句。';

/**
 * 尾部首句锚候选文本（v3）。
 *
 * v3 判据换轨：从「禁止若干英文短语」改为**可判定形态**——
 *   第一句必须包含中文字符，且不得以 ASCII 字母开头。
 * 黑名单降级为辅助提示：枚举永远不完备（实测 `The user wants…`、`The task: …` 就不在 v2 默认黑名单里）。
 */
export const TAIL_CANDIDATES = {
  A: '【本步语言要求】第一句必须包含中文字符，不得以 ASCII 字母开头。正确示范：「先读文件，再判断。」',
  B: '【语言·硬约束】本步 reasoning 第一句必须含中文字符（第一句内至少一个汉字），首字符不得是 ASCII 字母；辅助提示（枚举不完备）：Let me / The user wants / The task: 都不算中文首句。',
  C: '【语言·自查】起笔前自查：第一句有没有汉字？第一个字符是不是 ASCII 字母？两项都过再写下去。',
};

/** 默认尾锚 = A 版。 */
export const TAIL_TEXT = TAIL_CANDIDATES.A;

// ── v3：可判定首句判据 + 中文 few-shot + step 级变体 ──

/**
 * 可判定判据：第一句必须包含中文字符（U+4E00–U+9FFF），且不得以 ASCII 字母开头。
 * 这两条都能被 harness 用正则直接判真假，不依赖「枚举英文起手短语」。
 */
export const FIRST_SENTENCE_CLAUSE =
  '本步 reasoning 第一句必须包含中文字符（U+4E00-U+9FFF），不得以 ASCII 字母开头。';

/** 2 个中文首句正确示范（总长 ≤60 字符），让模型有可模仿的形状。 */
export const FIRST_SENTENCE_FEW_SHOT = [
  '正确示范：「先确认工作区结构，再改代码。」',
  '正确示范：「这一步先读文件，再下判断。」',
];

/**
 * 英文起手黑名单：v3 起降级为**辅助提示**。
 * 实测已见 `Let me start by…`、`The user asks…`、`The user wants…`、`The task: …` 四种起手，
 * 其中 `The user wants` / `The task:` 不在 v2 默认黑名单——枚举永远不完备，所以它不能当唯一判据。
 */
export const ENGLISH_OPENER_HINTS =
  "辅助提示（枚举永远不完备）：Let me / Let's / I'll / We need to / The user wants / The task: 都不算中文首句。";

/**
 * per-request 尾约束的 3 个变体（v3）。
 *
 * 为什么不再固定一段文本：宿主对 runtime-context 快照的判重单位是**整包 sections**，
 * 文本固定时同一份快照只会 append 一次，长任务里约束会被稀释（工具调用越多越稀释）。
 * 按 step 轮换文本 → 整包每次不同 → 每步都会重新 append，约束持续贴着采样点。
 * 代价：每个 step 多一条短快照（约 80–120 字符）。`config.contextVariant = false` 可回到固定文本。
 */
export const REQUEST_VARIANTS = [
  "【本步语言要求】第一句必须包含中文字符，不得以 ASCII 字母开头。正确示范：「先确认工作区结构，再改代码。」「这一步先读文件，再下判断。」辅助提示（枚举永远不完备）：Let me / Let's / The user wants / The task: 都不算中文首句。",
  '【本步语言要求·包括这一句】就这一句：第一句必须含中文字符，首字符不得是 ASCII 字母。正确示范：「先读文件，再判断。」「先确认边界，再动手。」',
  '【本步语言要求·工具结果之后】读完工具结果，第一句仍然必须含中文字符、不得以 ASCII 字母开头。正确示范：「结果已拿到，接下来改代码。」',
];

/** 默认（contextVariant=off 时）使用的固定文本 = 基础变体。 */
export const REQUEST_TEXT = REQUEST_VARIANTS[0];

// ── v3.1：token 预算（三档 preset + 变体降频 + 成本估算） ──

/**
 * 紧凑版文本（standard 档用）：保留可判定判据与关键边界，去掉示例与枚举提示。
 * 预算口径见 estimateTokens()：中文按 1 token/字、非中文按 4 字符≈1 token 保守估算。
 */
export const HEAD_TEXT_COMPACT =
  '**语言铁律（部署级）** 推理与可见输出一律简体中文；仅代码、命令、路径、报错保持原文；除非用户要求其他语言。';

export const MID_TEXT_COMPACT = '语言重申：第一句必须包含中文字符，不得以 ASCII 字母开头。';

/** standard 档的 3 个紧凑变体（必须仍含可判定判据）。 */
export const REQUEST_VARIANTS_COMPACT = [
  '【本步】第一句必须含中文字符，不得以 ASCII 字母开头。正确示范：「先读文件，再判断。」',
  '【本步·含这一句】这一句也要中文：首字符不得是 ASCII 字母。正确示范：「先读文件，再判断。」',
  '【本步·工具之后】读完工具结果，第一句仍然必须含中文字符。正确示范：「结果已拿到，接下来改代码。」',
];

/** standard 档固定文本（contextVariant=off 时）。 */
export const REQUEST_TEXT_COMPACT = REQUEST_VARIANTS_COMPACT[0];

/**
 * token 估算（保守上界，供 README 与 selftest 用同一口径）：
 * 中文 1 token/字；非中文字符按 4 字符≈1 token；向上取整。
 */
export function estimateTokens(text) {
  const value = String(text ?? '');
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length;
  return Math.ceil(cjk + (value.length - cjk) / 4);
}

/**
 * 三档 preset：决定注册哪些通道、用哪套文本、以及每次请求的 token 预算。
 * 与 contextVariant 正交：preset 管「发什么」，contextVariant 管「多久变一次」。
 */
export const PRESETS = {
  minimal: {
    channels: ['tail', 'context'],
    texts: {
      tail: TAIL_TEXT,
      request: REQUEST_TEXT,
      requestVariants: REQUEST_VARIANTS,
    },
    tokenBudget: 130,
  },
  standard: {
    channels: ['head', 'subagent', 'mid', 'tail', 'context'],
    texts: {
      head: HEAD_TEXT_COMPACT,
      subagent: SUBAGENT_TEXT,
      mid: MID_TEXT_COMPACT,
      tail: TAIL_TEXT,
      request: REQUEST_TEXT_COMPACT,
      requestVariants: REQUEST_VARIANTS_COMPACT,
    },
    tokenBudget: 300,
  },
  full: {
    channels: ['head', 'subagent', 'mid', 'tail', 'context'],
    texts: {
      head: HEAD_TEXT,
      subagent: SUBAGENT_TEXT,
      mid: MID_TEXT,
      tail: TAIL_TEXT,
      request: REQUEST_TEXT,
      requestVariants: REQUEST_VARIANTS,
    },
    tokenBudget: 400,
  },
};

/** 默认档：full（与 v3.0.0 行为一致；省 token 请显式选 minimal/standard）。 */
export const DEFAULT_PRESET = 'full';

/**
 * contextVariant 三态归一化：
 *   'off' / false  → 固定文本（宿主整包去重 → 只 append 一次，最省）
 *   'step' / true  → 每次 assembly 切换（约束最强，长任务成本最高）
 *   'lazy'         → 每 3 次 assembly 或首次工具结果后切换（**v3.1 默认**，约为 step 的 1/3 成本）
 * @returns {'off'|'step'|'lazy'}
 */
export function normalizeContextVariant(value) {
  if (value === false || value === 'off') return 'off';
  if (value === true || value === 'step') return 'step';
  return 'lazy';
}

/**
 * 变体 provider：按 mode 决定切换频率。
 * 计数以「provider 调用次数」为准。
 * ⚠️ 仅用于 step 模式（每次 assembly 切换）。lazy 必须用 createStepAwareVariantProvider：
 * 宿主在一次 step 内可能多次调用 provider（preStep assemble + step 内 refreshContext + 重试），
 * 按调用次数计数的 lazy 会被放大（t24 实测 long 组 append/step = 0.783，而不是预期的 0.33）。
 * @param {'step'} [mode]
 * @param {readonly string[]} [variants]
 * @returns {() => string}
 */
export function createRequestVariantProvider(mode = 'step', variants = REQUEST_VARIANTS) {
  let cursor = 0;
  let calls = 0;
  return function nextRequestVariant() {
    calls += 1;
    if (mode === 'step' && calls > 1) cursor += 1;
    return variants[cursor % variants.length];
  };
}

/** 「工具结果之后」变体在变体表中的下标（覆盖 mid 场景：只读 1–2 个文件、2–3 段）。 */
export const TOOL_RESULT_VARIANT_INDEX = 2;

/**
 * step 感知的变体 provider（v3.1.1 修复 lazy 成本；v3.1.3 修复工具结果作用域）。
 *
 * 计数单位是 **step**，不是 provider 调用次数：
 *   - 优先：宿主事件驱动（apply 里监听 `session/event` 的 `step/start` 与 `tool/result`）；
 *   - 退路：时间窗启发式 —— 同一 signal 且距上次调用 < sameStepWindowMs 视为同一 step。
 *
 * lazy 的切换规则：`floor(step / 3) % variants.length` → 第 1/4/7/10 个 step 切换。
 *
 * 工具结果优先（v3.1.3 修正）：`noteToolResult()` 之后，**整个下一个 step 的所有调用**都返回
 * 「工具结果之后」变体，直到该 step 结束再恢复轮换。旧实现只覆盖「下一次调用」——若该 step
 * 在 tool/result 后还有 `refreshContext()` 调用，会把变体在同一步消费掉，下一个 step 已恢复轮换
 * （t37 实测命中率仅 1/3，mid「读一个文件→同一步总结」恰是最需要它的形态）。
 *
 * @param {{mode?: 'lazy'|'step', variants?: readonly string[], now?: () => number, sameStepWindowMs?: number}} [options]
 */
export function createStepAwareVariantProvider(options = {}) {
  const mode = options.mode ?? 'lazy';
  const variants = options.variants ?? REQUEST_VARIANTS;
  const now = options.now ?? (() => Date.now());
  const sameStepWindowMs = options.sameStepWindowMs ?? 1500;
  const toolVariant = variants[TOOL_RESULT_VARIANT_INDEX] ?? variants[variants.length - 1];

  let stepIndex = -1;
  let externalSteps = false;
  let lastCallAt = null;
  let lastSignal = null;
  /** 已观察到 tool/result，等待下一个 step 开始时激活工具变体。 */
  let pendingToolStep = false;
  /** 当前 step 整段使用工具变体（直到下一个 step 开始）。 */
  let toolStepActive = false;

  /** 进入一个新 step：结束上一 step 的工具变体、激活待处理的工具变体、推进 step 计数。 */
  const beginStep = () => {
    if (toolStepActive) toolStepActive = false;
    if (pendingToolStep) {
      pendingToolStep = false;
      toolStepActive = true;
    }
    stepIndex += 1;
    lastCallAt = null;
    lastSignal = null;
  };

  return {
    /** 宿主事件：新 step 开始。调用后 text() 不再自行推进 step。 */
    noteStepStart() {
      externalSteps = true;
      beginStep();
    },
    /** 宿主事件：本 step 观察到工具结果 → 下一个 step 整段使用「工具结果之后」变体。 */
    noteToolResult() {
      pendingToolStep = true;
    },
    /** 当前 step 序号（0-based，-1 表示尚未开始）；供 selftest/测量脚本读取。 */
    get step() {
      return stepIndex;
    },
    /** 当前 step 是否处于「工具结果之后」状态。 */
    get toolStep() {
      return toolStepActive;
    },
    /** provider 本体：宿主每次 assembly 调用一次。 */
    text(context) {
      const at = now();
      const signal = context?.signal ?? null;
      if (!externalSteps) {
        const sameStep = lastCallAt !== null && at - lastCallAt < sameStepWindowMs && signal === lastSignal;
        if (!sameStep) beginStep();
      }
      lastCallAt = at;
      lastSignal = signal;
      // 工具结果之后的整个 step 都用工具变体（不再只消费一次）。
      if (toolStepActive) return toolVariant;
      if (mode === 'step') return variants[Math.max(stepIndex, 0) % variants.length];
      const index = Math.floor(Math.max(stepIndex, 0) / 3) % variants.length;
      return variants[index];
    },
  };
}

// ── 默认 order（可被 config 覆盖） ──

/** harness:identity 是 -1000，部署 persona 是 0；铁律卡在两者之间。 */
export const DEFAULT_HEAD_ORDER = -900;
/** 子智能体锚紧跟头锚，语义连续。 */
export const DEFAULT_SUBAGENT_ORDER = -880;
/** TOOLS_SDK 是 5000，DELIVERABLE_FILE_REFERENCES 是 9000；重申句卡在两者之间。 */
export const DEFAULT_MID_ORDER = 5100;
/** 宿主 section 上界 10200；90050 是 v1 起既有的「绝对最后」值，保留以兼容。 */
export const DEFAULT_TAIL_ORDER = 90050;
/** 宿主 context 上界 210（WEB_SURFACE）；500 保证排在全部宿主 context 之后。 */
export const DEFAULT_REQUEST_ORDER = 500;

/** 宿主 SECTION_ORDERS 上界（dsh 0.2.2-rc.3 实测：DEPLOYMENT_PERSONA_SUFFIX = 10200）。 */
export const HOST_SECTION_MAX_FALLBACK = 10200;
/** 宿主 CONTEXT_ORDERS 上界（dsh 0.2.2-rc.3 实测：WEB_SURFACE = 210）。 */
export const HOST_CONTEXT_MAX_FALLBACK = 210;

// ── 工具函数 ──

function pickText(candidate, fallback) {
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate : fallback;
}

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * 探测宿主中央分配的 order 上界；服务方法缺失或抛错时回退到实测常量。
 * 这一步让 order 的「为什么这么大」可解释且随宿主版本自适应，而不是硬编码猜测。
 */
function probeHostOrder(registry, method, key, fallback) {
  try {
    const fn = registry?.[method];
    if (typeof fn !== 'function') return fallback;
    const value = fn.call(registry, key);
    return Number.isFinite(value) ? Math.max(value, fallback) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 与宿主 `RuntimeContextProjection.project()` 的整包比较判据对齐：
 * 只有本 step 的 context sections 与上一份不同才 append 新快照（旧快照保留在 surface，
 * 不做 replace），固定文本因此天然只注入一次。
 * 导出它是为了让 selftest/单测能直接断言「同一 step 只注入一次」。
 * @param {readonly string[] | null | undefined} previous 上一份 retained 内容；undefined=从未注入，null=已清除
 * @param {readonly string[]} next 本 step 将渲染的内容
 */
export function requestTailNeedsCommit(previous, next) {
  if (next.length === 0) return previous !== undefined && previous !== null;
  if (previous === undefined || previous === null) return true;
  if (previous.length !== next.length) return true;
  return previous.some((value, index) => value !== next[index]);
}

// ── 插件入口 ──

/**
 * @param {any} ctx cordis 插件上下文
 * @param {Record<string, any>} [config] 部署配置
 */
export function apply(ctx, config = {}) {
  const settings = config && typeof config === 'object' ? config : {};
  if (settings.enabled === false) return;

  const registry = ctx?.systemPrompt;
  if (!registry || typeof registry.section !== 'function') return;

  const registered = [];
  const skipped = [];
  const debug = (message, meta) => {
    try {
      ctx?.logger?.debug?.(message, meta);
    } catch {
      /* 日志不可用不影响注入 */
    }
  };

  /**
   * 注册一条 section；失败只记 debug，绝不影响其它锚。
   * @returns {boolean} 是否注册成功
   */
  const addSection = (sectionName, order, text) => {
    if (typeof text !== 'string' || text.trim() === '') {
      skipped.push({ kind: 'section', name: sectionName, reason: 'empty-text' });
      return false;
    }
    try {
      registry.section({ name: sectionName, order, text, interpolate: false });
      registered.push({ kind: 'section', name: sectionName, order });
      return true;
    } catch (error) {
      skipped.push({ kind: 'section', name: sectionName, reason: 'register-failed', error: String(error?.message ?? error) });
      debug('[lang-rule] section 注册跳过', { name: sectionName, order });
      return false;
    }
  };

  // ── preset：决定注册哪些通道与用哪套文本（与 contextVariant 正交） ──
  const presetName = Object.hasOwn(PRESETS, settings.preset) ? settings.preset : DEFAULT_PRESET;
  const preset = PRESETS[presetName];
  const channels = new Set(preset.channels);
  const presetText = (key) => preset.texts[key];

  const sectionName = pickText(settings.sectionName, 'lang-rule');
  const headOrder = finiteOr(settings.headOrder, finiteOr(settings.order, DEFAULT_HEAD_ORDER));
  const headText = pickText(settings.headText, pickText(settings.text, presetText('head') ?? HEAD_TEXT));
  if (channels.has('head') && settings.headEnabled !== false) addSection(sectionName, headOrder, headText);

  if (channels.has('subagent') && settings.subagentEnabled !== false) {
    const subagentOrder = finiteOr(settings.subagentOrder, DEFAULT_SUBAGENT_ORDER);
    const subagentName = pickText(settings.subagentSectionName, 'lang-rule:subagent');
    const subagentText = pickText(settings.subagentText, presetText('subagent') ?? SUBAGENT_TEXT);
    addSection(subagentName, subagentOrder, subagentText);
  }

  if (channels.has('mid') && settings.midEnabled !== false) {
    const midOrder = finiteOr(settings.midOrder, DEFAULT_MID_ORDER);
    const midName = pickText(settings.midSectionName, 'lang-rule:mid');
    const midText = pickText(settings.midText, presetText('mid') ?? MID_TEXT);
    addSection(midName, midOrder, midText);
  }

  if (channels.has('tail') && settings.tailEnabled !== false) {
    const hostSectionMax = probeHostOrder(
      registry,
      'getSectionOrder',
      'DEPLOYMENT_PERSONA_SUFFIX',
      HOST_SECTION_MAX_FALLBACK,
    );
    // 宿主上界 + 1000 与 v1 既有值取大：既保证「排在宿主全部 section 之后」，又保持向后兼容。
    const tailOrder = finiteOr(settings.tailOrder, Math.max(DEFAULT_TAIL_ORDER, hostSectionMax + 1000));
    const tailName = pickText(settings.tailSectionName, 'lang-rule:tail');
    const tailText = pickText(settings.tailText, presetText('tail') ?? TAIL_TEXT);
    addSection(tailName, tailOrder, tailText);
  }

  // ── per-request 尾约束：每请求重新渲染的 runtime context ──
  // config.requestTail = 'off' → 完全回到 v1 的纯 section 行为（回归对比用）。
  const requestMode = settings.requestTail === undefined ? 'context' : settings.requestTail;
  const variantMode = normalizeContextVariant(settings.contextVariant);
  if (channels.has('context') && requestMode !== 'off' && requestMode !== false && settings.requestEnabled !== false) {
    const hostContextMax = probeHostOrder(registry, 'getContextOrder', 'WEB_SURFACE', HOST_CONTEXT_MAX_FALLBACK);
    const requestOrder = finiteOr(settings.requestOrder, Math.max(DEFAULT_REQUEST_ORDER, hostContextMax + 100));
    const requestName = pickText(settings.requestSectionName, 'lang-rule:request-tail');
    const customRequestText = typeof settings.requestText === 'string' && settings.requestText.trim() !== '';
    const baseRequestText = presetText('request') ?? REQUEST_TEXT;
    const variants = presetText('requestVariants') ?? REQUEST_VARIANTS;
    // off → 固定文本（宿主整包去重 → 只 append 一次）；
    // step → 每 step 切换（成本最高）；
    // lazy（默认）→ 每 3 step 切换。
    // 两者共用 step 感知 tracker：都监听 step/start 精确计数、都接 tool/result 优先返回
    // 「工具结果之后」变体——保证「工具结果之后」在两种模式下都生效（t33 F1）。
    let requestText;
    if (customRequestText) {
      requestText = settings.requestText;
    } else if (variantMode === 'off') {
      requestText = baseRequestText;
    } else {
      // 每个 agent 一个 tracker：全局插件实例会同时服务多个会话，step 事件必须按 agent/session 隔离，
      // 否则 A 会话的 step 会推进 B 会话的变体。
      const trackers = new Map();
      // settings.now 是测试钩子（可注入假时钟）；生产不设置时用 Date.now()。
      const trackerOptions = typeof settings.now === 'function' ? { now: settings.now } : {};
      const trackerFor = (key) => {
        const id = typeof key === 'string' && key !== '' ? key : 'global';
        let tracker = trackers.get(id);
        if (tracker === undefined) {
          tracker = createStepAwareVariantProvider({ mode: variantMode, variants, ...trackerOptions });
          trackers.set(id, tracker);
        }
        return tracker;
      };
      // 宿主事件驱动（尽力而为）：step/start 精确推进 step；tool/result 触发下一步立即切换。
      // 事件不可用（ctx.on 缺失、签名不符、或全局收不到）时，tracker 自动退回时间窗启发式。
      if (typeof ctx?.on === 'function') {
        try {
          ctx.on('session/event', (subject, event) => {
            if (event === null || typeof event !== 'object') return;
            if (event.type !== 'step/start' && event.type !== 'tool/result') return;
            const tracker = trackerFor(subject?.id ?? null);
            if (event.type === 'step/start') tracker.noteStepStart();
            else tracker.noteToolResult();
          });
        } catch {
          debug('[lang-rule] session/event 监听不可用，变体退回时间窗计数');
        }
      }
      requestText = (context) => trackerFor(context?.agent?.id ?? context?.scope?.id ?? null).text(context);
    }
    if (typeof registry.context !== 'function') {
      // 旧宿主无 context() 通道：degraded 到「仅 system 锚」，不抛错、不阻断启动。
      skipped.push({ kind: 'context', name: requestName, reason: 'context-api-unavailable' });
      debug('[lang-rule] 宿主无 systemPrompt.context()，per-request 通道降级', { name: requestName });
    } else if (typeof requestText === 'string' && requestText.trim() === '') {
      skipped.push({ kind: 'context', name: requestName, reason: 'empty-text' });
    } else {
      try {
        // required:true 保证部署若关闭了 runtime context（suppressRuntimeContext），语言约束仍在。
        registry.context({
          name: requestName,
          order: requestOrder,
          text: requestText,
          interpolate: false,
          required: true,
        });
        registered.push({
          kind: 'context',
          name: requestName,
          order: requestOrder,
          variant: typeof requestText === 'function' ? variantMode : 'off',
        });
      } catch (error) {
        skipped.push({ kind: 'context', name: requestName, reason: 'register-failed', error: String(error?.message ?? error) });
        debug('[lang-rule] context 注册跳过', { name: requestName, order: requestOrder });
      }
    }
  }

  // 可观测：注册成功打印各 section 的 name 与 order；失败只在 debug 级说明。
  try {
    if (registered.length > 0) {
      ctx?.logger?.info?.('[lang-rule] v3 已注册语言约束', {
        preset: presetName,
        channels: registered.map((entry) => `${entry.kind}:${entry.name}@${entry.order}`),
        requestTail: requestMode,
        contextVariant: variantMode,
        degraded: !registered.some((entry) => entry.kind === 'context') && requestMode !== 'off',
      });
    }
    if (skipped.length > 0) debug('[lang-rule] 部分通道未注册', { skipped });
  } catch {
    /* 日志不可用不影响注入 */
  }
}

export default { name, inject, apply };
