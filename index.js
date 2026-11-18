/**
 * dsh-lang-rule v2 — 部署级语言策略插件。
 *
 * 目标（由全量语料审计 LANG-AUDIT 定位）：
 *   1. 首句是唯一强预测因子：首句英文 → 整段英文 81.1%，首句中文 → 1.1%；
 *   2. v1 的 head+tail 已把英文主导率从 39.7% 压到 13.4%，再加长尾锚边际收益极低；
 *   3. 真正漏点在「请求内部」：system 之后还压着 15.6–16.7 KB user 文本，尾锚在 system 里
 *      只能保证「system 段内最后」，保证不了「请求最后」。
 *
 * 因此 v2 用五处注入，前四处是 system prompt section，第五处是每请求重新组装的 runtime context：
 *
 *   [section] order -900   头部铁律锚      长版定性，紧跟 harness 身份段
 *   [section] order -880   子智能体强化锚  显式点名 subagent / AgentTeams / workflow / 后台任务
 *   [section] order 5100   工具文档后重申  在工具 schema 之后、结构化输出之前补一次短约束
 *   [section] order 90050  尾部首句锚      排在全部宿主 section 之后（宿主上界 10200）
 *   [context] order 500    请求尾上下文    宿主每次请求重新渲染，快照 append 在 claimed 消息之后
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
 *   - per-request 通道不可用时进入 degraded 模式（仅 system 三/四锚），并在日志 debug 级说明。
 *
 * 回归开关：config.requestTail = 'off' 时完全不注册 context，行为回到 v1 的纯 section 版本；
 * config.enabled = false 时整插件不注册任何东西（用于基线对照）。
 */

export const name = 'lang-rule';

/** 等 system-prompt 注册表就绪后再贡献锚点。 */
export const inject = ['systemPrompt'];

// ── 文本（长度预算：头 ≤250 / 子智能体 ≤60 / mid ≤150 / 尾 ≤80 / 请求尾 ≤80 字符） ──

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

/** 工具文档之后的重申句（order 5100，位于工具 schema 与结构化输出之间）。 */
export const MID_TEXT =
  "语言重申：reasoning 与回复用简体中文；第一句必须中文，不得以 Let me / Let's / I'll / We need to 起手；英文任务提示不豁免。";

/**
 * 尾部首句锚候选文本。
 * A 最短、判据最稳、token 最省 —— 默认使用（gate-reviewer 纠偏：不要写「第一个字符必须是中文」，
 * reasoning 首字符常是 `**`、反引号、数字或空格，会导致假阴性；统一用「第一句」）。
 */
export const TAIL_CANDIDATES = {
  A: "【本步语言要求】第一句必须简体中文；不得以 Let me / Let's / I'll / We need to 起手；任务提示是英文也不豁免。",
  B: "【语言·硬约束】本步 reasoning 的第一句必须是简体中文，不得以 Let me / Let's / I'll / We need to / The user wants 等英文短语起手；任务提示是英文也不豁免。",
  C: "【语言·自查】起笔前自查：第一句写简体中文，不写 Let me / Let's / I'll / We need to / The user wants；任务说明是英文也照此执行。",
};

/** 默认尾锚 = A 版。 */
export const TAIL_TEXT = TAIL_CANDIDATES.A;

/**
 * per-request 尾约束：宿主把它作为 runtime context 快照渲染成 `<system-reminder>`，
 * 在每个 step 的 claimed 消息之后 append，是模型在本步看到的最靠近采样点的系统级文本。
 * 文本固定 → 宿主 deepEqualJson 去重，同一步不会重复追加。
 */
export const REQUEST_TEXT =
  "【本步语言要求】第一句必须是简体中文；禁止以 Let me / Let's / I'll / We need to 开头；英文任务提示不豁免。";

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

  const sectionName = pickText(settings.sectionName, 'lang-rule');
  const headOrder = finiteOr(settings.headOrder, finiteOr(settings.order, DEFAULT_HEAD_ORDER));
  const headText = pickText(settings.headText, pickText(settings.text, HEAD_TEXT));
  if (settings.headEnabled !== false) addSection(sectionName, headOrder, headText);

  if (settings.subagentEnabled !== false) {
    const subagentOrder = finiteOr(settings.subagentOrder, DEFAULT_SUBAGENT_ORDER);
    const subagentName = pickText(settings.subagentSectionName, 'lang-rule:subagent');
    const subagentText = pickText(settings.subagentText, SUBAGENT_TEXT);
    addSection(subagentName, subagentOrder, subagentText);
  }

  if (settings.midEnabled !== false) {
    const midOrder = finiteOr(settings.midOrder, DEFAULT_MID_ORDER);
    const midName = pickText(settings.midSectionName, 'lang-rule:mid');
    const midText = pickText(settings.midText, MID_TEXT);
    addSection(midName, midOrder, midText);
  }

  if (settings.tailEnabled !== false) {
    const hostSectionMax = probeHostOrder(
      registry,
      'getSectionOrder',
      'DEPLOYMENT_PERSONA_SUFFIX',
      HOST_SECTION_MAX_FALLBACK,
    );
    // 宿主上界 + 1000 与 v1 既有值取大：既保证「排在宿主全部 section 之后」，又保持向后兼容。
    const tailOrder = finiteOr(settings.tailOrder, Math.max(DEFAULT_TAIL_ORDER, hostSectionMax + 1000));
    const tailName = pickText(settings.tailSectionName, 'lang-rule:tail');
    const tailText = pickText(settings.tailText, TAIL_TEXT);
    addSection(tailName, tailOrder, tailText);
  }

  // ── per-request 尾约束：每请求重新渲染的 runtime context ──
  // config.requestTail = 'off' → 完全回到 v1 的纯 section 行为（回归对比用）。
  const requestMode = settings.requestTail === undefined ? 'context' : settings.requestTail;
  if (requestMode !== 'off' && requestMode !== false && settings.requestEnabled !== false) {
    const hostContextMax = probeHostOrder(registry, 'getContextOrder', 'WEB_SURFACE', HOST_CONTEXT_MAX_FALLBACK);
    const requestOrder = finiteOr(settings.requestOrder, Math.max(DEFAULT_REQUEST_ORDER, hostContextMax + 100));
    const requestName = pickText(settings.requestSectionName, 'lang-rule:request-tail');
    const requestText = pickText(settings.requestText, REQUEST_TEXT);
    if (typeof registry.context !== 'function') {
      // 旧宿主无 context() 通道：degraded 到「仅 system 锚」，不抛错、不阻断启动。
      skipped.push({ kind: 'context', name: requestName, reason: 'context-api-unavailable' });
      debug('[lang-rule] 宿主无 systemPrompt.context()，per-request 通道降级', { name: requestName });
    } else if (requestText.trim() === '') {
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
        registered.push({ kind: 'context', name: requestName, order: requestOrder });
      } catch (error) {
        skipped.push({ kind: 'context', name: requestName, reason: 'register-failed', error: String(error?.message ?? error) });
        debug('[lang-rule] context 注册跳过', { name: requestName, order: requestOrder });
      }
    }
  }

  // 可观测：注册成功打印各 section 的 name 与 order；失败只在 debug 级说明。
  try {
    if (registered.length > 0) {
      ctx?.logger?.info?.('[lang-rule] v2 已注册语言约束', {
        channels: registered.map((entry) => `${entry.kind}:${entry.name}@${entry.order}`),
        requestTail: requestMode,
        degraded: !registered.some((entry) => entry.kind === 'context') && requestMode !== 'off',
      });
    }
    if (skipped.length > 0) debug('[lang-rule] 部分通道未注册', { skipped });
  } catch {
    /* 日志不可用不影响注入 */
  }
}

export default { name, inject, apply };
