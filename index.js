/**
 * dsh-lang-rule — 部署级语言策略插件。
 *
 * 通过 `ctx.systemPrompt.section()` 向系统提示词注册表贡献两条中文约束：
 *
 *   头部锚 order -900     长版铁律，紧跟 harness 身份段，负责"定性"。
 *   尾部锚 order 90050    一行短提醒，紧贴采样点，负责"逼第一句"。
 *
 * 为什么需要尾部锚：reasoning 每个 step 独立采样，首句语言一旦为英文，
 * 后续自回归全程英文（实测 16 个子智能体：首句中文的 98% 段落中文，
 * 首句英文的 92%+ 段落英文，中途翻转几乎为零）。头部锚离采样点隔着
 * 十几 KB 英文工具 schema，约束力被摊薄；尾部锚 recency 最强。
 *
 * 覆盖面：全局 section 对所有 agent 作用域生效 —— 主 agent、subagent、
 * AgentTeams 成员、Agency expert、后台任务，全部拿到同一段约束。
 *
 * 抗升级设计：
 *  - 不 import 任何 cordis / dsh 内部模块，只使用 ctx 暴露的服务；
 *  - systemPrompt 服务缺失或 section() 签名变更时静默退出，绝不阻断 dsh 启动；
 *  - 同名 section 已被其他插件占用时让出，不抛错。
 */

export const name = 'lang-rule';

/** 等 system-prompt 注册表就绪后再贡献 section。 */
export const inject = ['systemPrompt'];

/** 默认铁律正文。不含换行缩进，保持 Markdown 紧凑。 */
const DEFAULT_TEXT = [
  '**语言铁律（部署级策略，优先于本提示其余一切英文表述）**',
  '- 所有内部推理（thinking / reasoning）与所有可见输出，一律使用简体中文；不得用英文思考。',
  '- 子智能体、团队成员、后台任务、委派提示词，以及它们的产出，同样全程简体中文。',
  '- 计划、执行摘要、评审结论、错误说明一律中文；仅代码、命令、路径、API 名、报错原文保持英文。',
  '- 唯一例外：用户明确要求改用其他语言。',
].join('\n');

/** harness:identity 是 -1000，部署 persona 是 0；铁律卡在两者之间。 */
const DEFAULT_ORDER = -900;

/**
 * 尾部锚正文：短、固定、直指"第一句"。
 * 越短越贴采样点；文本固定才不会破坏 prompt cache。
 */
const DEFAULT_TAIL_TEXT =
  '**【本步语言要求】** 本步 reasoning 的第一句必须用简体中文起草，全程不得切换到英文思考；可见回复同样中文（代码、命令、路径、报错原文除外）。';

/** 排在全部宿主 section 之后，recency 最强。 */
const DEFAULT_TAIL_ORDER = 90050;

export function apply(ctx, config = {}) {
  const registry = ctx?.systemPrompt;
  if (!registry || typeof registry.section !== 'function') return;

  const registered = [];

  // ── 头部锚：长版铁律 ──────────────────────────────────────────────
  const text = typeof config.text === 'string' && config.text.trim() !== '' ? config.text : DEFAULT_TEXT;
  const order = Number.isFinite(config.order) ? config.order : DEFAULT_ORDER;
  const sectionName = typeof config.sectionName === 'string' && config.sectionName.trim() !== ''
    ? config.sectionName
    : 'lang-rule';

  try {
    registry.section({ name: sectionName, order, text });
    registered.push({ sectionName, order });
  } catch {
    /* 同名已被占用：让出，继续尝试尾部锚 */
  }

  // ── 尾部锚：逼第一句（可用 config.tailText = '' 关闭） ─────────────
  if (config.tailEnabled !== false) {
    const tailText = typeof config.tailText === 'string' ? config.tailText : DEFAULT_TAIL_TEXT;
    if (tailText.trim() !== '') {
      const tailOrder = Number.isFinite(config.tailOrder) ? config.tailOrder : DEFAULT_TAIL_ORDER;
      const tailName = typeof config.tailSectionName === 'string' && config.tailSectionName.trim() !== ''
        ? config.tailSectionName
        : 'lang-rule:tail';
      try {
        registry.section({ name: tailName, order: tailOrder, text: tailText });
        registered.push({ sectionName: tailName, order: tailOrder });
      } catch {
        /* 尾部锚失败不影响头部锚 */
      }
    }
  }

  // 让语言策略在日志里可观测，便于升级后确认仍在生效。
  try {
    if (registered.length > 0) ctx?.logger?.info?.('[lang-rule] 已注册系统提示 section', { registered });
  } catch {
    /* 日志不可用不影响注入 */
  }
}
