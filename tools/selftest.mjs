#!/usr/bin/env node
/**
 * selftest — dsh-lang-rule v2 的注册契约自检（不需要 dsh 运行时）。
 *
 * 用假 ctx 断言：
 *   - 默认注册 5 个通道（4 个 system prompt section + 1 个 per-request runtime context）；
 *   - 每个通道的 name / order / text 关键词；
 *   - 尾部锚 order 的推导依据（宿主 section 上界 10200 → 90050；探测到更大上界时自适应）；
 *   - per-request 通道的 order 必须大于宿主 context 上界 210；
 *   - requestTail='off' 完全回到 v1 的纯 section 行为；
 *   - systemPrompt 缺失、section()/context() 抛错、logger 缺失三种降级路径都不抛异常；
 *   - 固定文本的 per-request 快照在重复 step 上只提交一次（与宿主 supersession 判据对齐）。
 *
 * 退出码 0 = 全部通过。
 */
import {
  apply,
  HEAD_TEXT,
  HEAD_TEXT_COMPACT,
  SUBAGENT_TEXT,
  MID_TEXT,
  MID_TEXT_COMPACT,
  TAIL_TEXT,
  TAIL_CANDIDATES,
  REQUEST_TEXT,
  REQUEST_TEXT_COMPACT,
  REQUEST_VARIANTS,
  REQUEST_VARIANTS_COMPACT,
  FIRST_SENTENCE_CLAUSE,
  FIRST_SENTENCE_FEW_SHOT,
  ENGLISH_OPENER_HINTS,
  PRESETS,
  DEFAULT_PRESET,
  estimateTokens,
  normalizeContextVariant,
  createRequestVariantProvider,
  createStepAwareVariantProvider,
  TOOL_RESULT_VARIANT_INDEX,
  DEFAULT_HEAD_ORDER,
  DEFAULT_SUBAGENT_ORDER,
  DEFAULT_MID_ORDER,
  DEFAULT_TAIL_ORDER,
  DEFAULT_REQUEST_ORDER,
  HOST_SECTION_MAX_FALLBACK,
  HOST_CONTEXT_MAX_FALLBACK,
  requestTailNeedsCommit,
} from '../index.js';
import { detectRequestTailEvidence } from './lib/request-tail-detect.mjs';
import { firstSentenceLanguage, cjkRatio, segmentMetrics, summarizeLongTasks } from './lib/lang-metrics.mjs';

let passed = 0;
const failures = [];

function test(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✅ ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`❌ ${label}\n   ${error?.message ?? error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/** 假 systemPrompt 注册表：记录 section/context 调用，并按宿主实测值回答 order 探测。 */
function makeRegistry(overrides = {}) {
  const sections = [];
  const contexts = [];
  const registry = {
    sections,
    contexts,
    section(entry) {
      sections.push({ ...entry });
    },
    context(entry) {
      contexts.push({ ...entry });
    },
    getSectionOrder(name) {
      return name === 'DEPLOYMENT_PERSONA_SUFFIX' ? HOST_SECTION_MAX_FALLBACK : undefined;
    },
    getContextOrder(name) {
      return name === 'WEB_SURFACE' ? HOST_CONTEXT_MAX_FALLBACK : undefined;
    },
    ...overrides,
  };
  return registry;
}

function makeCtx(registry, options = {}) {
  const ctx = {};
  if (registry !== null) ctx.systemPrompt = registry;
  if (options.logger !== false) {
    ctx.logger = { info() {}, debug() {} };
  }
  return ctx;
}

// ── 1. 默认注册：4 section + 1 context ───────────────────────────────
test('默认注册 5 个通道：4 个 section + 1 个 per-request context', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), {});
  assertEqual(registry.sections.length, 4, 'section 数量');
  assertEqual(registry.contexts.length, 1, 'context 数量');
  const names = registry.sections.map((entry) => entry.name);
  assertEqual(names[0], 'lang-rule', '头锚 name');
  assertEqual(names[1], 'lang-rule:subagent', '子智能体锚 name');
  assertEqual(names[2], 'lang-rule:mid', 'mid 锚 name');
  assertEqual(names[3], 'lang-rule:tail', '尾锚 name');
  assertEqual(registry.contexts[0].name, 'lang-rule:request-tail', 'per-request context name');
});

test('默认 order：头 -900 / 子 -880 / mid 5100 / 尾 ≥90050 / context 500', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), {});
  const orderOf = (name) => registry.sections.find((entry) => entry.name === name)?.order;
  assertEqual(orderOf('lang-rule'), DEFAULT_HEAD_ORDER, '头锚 order');
  assertEqual(orderOf('lang-rule:subagent'), DEFAULT_SUBAGENT_ORDER, '子智能体锚 order');
  assertEqual(orderOf('lang-rule:mid'), DEFAULT_MID_ORDER, 'mid 锚 order');
  assert(orderOf('lang-rule:tail') >= DEFAULT_TAIL_ORDER, '尾锚必须 ≥ 90050');
  assert(orderOf('lang-rule:tail') > HOST_SECTION_MAX_FALLBACK, '尾锚必须排在宿主 section 上界之后');
  assert(registry.contexts[0].order > HOST_CONTEXT_MAX_FALLBACK, 'per-request context 必须排在宿主 context 上界之后');
  assertEqual(registry.contexts[0].order, DEFAULT_REQUEST_ORDER, 'context 默认 order');
});

test('mid 锚夹在工具文档(5000)与结构化输出(9000)之间：order 5100', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), {});
  const mid = registry.sections.find((entry) => entry.name === 'lang-rule:mid');
  assert(mid.order > 5000 && mid.order < 9000, `mid order 期望 (5000,9000)，实际 ${mid.order}`);
});

// ── 2. 文本契约 ──────────────────────────────────────────────────────
test('头锚包含「语言铁律 / 简体中文 / 不得用英文思考」', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), {});
  const head = registry.sections[0].text;
  for (const keyword of ['语言铁律', '简体中文', '不得用英文思考', '代码、命令、路径']) {
    assert(head.includes(keyword), `头锚缺少关键词：${keyword}`);
  }
});

test('子智能体锚显式点名 subagent / AgentTeams / workflow / 后台任务', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), {});
  const subagent = registry.sections.find((entry) => entry.name === 'lang-rule:subagent');
  for (const keyword of ['子智能体', 'AgentTeams', 'workflow', '后台任务', '全中文']) {
    assert(subagent.text.includes(keyword), `子智能体锚缺少关键词：${keyword}`);
  }
});

test('尾锚含可判定硬约束：第一句 + 包含中文字符 + 不得以 ASCII 字母开头（v3）', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), {});
  const tail = registry.sections.find((entry) => entry.name === 'lang-rule:tail');
  for (const keyword of ['第一句', '包含中文字符', '不得以 ASCII 字母开头', '正确示范']) {
    assert(tail.text.includes(keyword), `尾锚缺少关键词：${keyword}`);
  }
  // 反向断言：不得出现「第一个字符」这种不可判定口径（首字符常是 ** 或反引号）。
  assert(!tail.text.includes('第一个字符'), '尾锚不得使用「第一个字符」口径');
  assert(!/如果|若|假如|除非/.test(tail.text), '尾锚不得包含条件从句');
});

test('per-request context 含同一组可判定硬约束（v3）', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), {});
  const request = registry.contexts[0];
  const text = typeof request.text === 'function' ? request.text() : request.text;
  for (const keyword of ['包含中文字符', '不得以 ASCII 字母开头']) {
    assert(text.includes(keyword), `请求尾 context 缺少关键词：${keyword}`);
  }
  assert(text.includes('The user wants') && text.includes('The task:'), '请求尾辅助提示必须覆盖实测漏网起手');
  assertEqual(request.required, true, 'context 必须 required（部署关闭 runtime context 时依然生效）');
  assertEqual(request.interpolate, false, 'context 不得做 {{variable}} 插值');
});

test('默认尾锚是候选 A 版，且候选表至少 3 版（v3 可判定判据）', () => {
  assertEqual(TAIL_TEXT, TAIL_CANDIDATES.A, '默认尾锚必须是 A 版');
  assert(Object.keys(TAIL_CANDIDATES).length >= 3, '候选文本至少 3 版');
  for (const [key, text] of Object.entries(TAIL_CANDIDATES)) {
    assert(text.includes('第一句'), `候选 ${key} 缺少「第一句」`);
    assert(/含中文字符|包含中文字符|汉字/.test(text), `候选 ${key} 缺少可判定判据`);
  }
});

test('长度预算：HEAD ≤160 / SUBAGENT ≤60 / MID ≤110 / TAIL ≤60 / REQUEST ≤140 字符', () => {
  const budgets = [
    ['HEAD_TEXT', HEAD_TEXT, 160],
    ['HEAD_TEXT_COMPACT', HEAD_TEXT_COMPACT, 160],
    ['SUBAGENT_TEXT', SUBAGENT_TEXT, 60],
    ['MID_TEXT', MID_TEXT, 110],
    ['MID_TEXT_COMPACT', MID_TEXT_COMPACT, 110],
    ['TAIL_TEXT', TAIL_TEXT, 60],
    ['REQUEST_TEXT', REQUEST_TEXT, 140],
    ['REQUEST_TEXT_COMPACT', REQUEST_TEXT_COMPACT, 140],
  ];
  for (const [label, text, limit] of budgets) {
    assert(text.length <= limit, `${label} 长度 ${text.length} 超过预算 ${limit}`);
  }
  for (const [label, variants, limit] of [
    ['REQUEST_VARIANTS', REQUEST_VARIANTS, 140],
    ['REQUEST_VARIANTS_COMPACT', REQUEST_VARIANTS_COMPACT, 140],
  ]) {
    for (const variant of variants) {
      assert(variant.length <= limit, `${label} 变体长度 ${variant.length} 超过 ${limit}`);
    }
  }
  // few-shot 总长预算（v3 起 ≤60）
  const fewShotTotal = FIRST_SENTENCE_FEW_SHOT.reduce((sum, text) => sum + text.length, 0);
  assert(fewShotTotal <= 60, `few-shot 总长 ${fewShotTotal} 超过 60`);
});

// ── 3. order 推导可解释、可覆盖 ─────────────────────────────────────
test('宿主 section 上界变大（20000）时尾锚自适应到 ≥21000', () => {
  const registry = makeRegistry({
    getSectionOrder(name) {
      return name === 'DEPLOYMENT_PERSONA_SUFFIX' ? 20000 : undefined;
    },
  });
  apply(makeCtx(registry), {});
  const tail = registry.sections.find((entry) => entry.name === 'lang-rule:tail');
  assert(tail.order >= 21000, `尾锚 order 应 ≥21000，实际 ${tail.order}`);
});

test('getSectionOrder 缺失或抛错时回退到 90050，不抛异常', () => {
  const registry = makeRegistry({
    getSectionOrder() {
      throw new Error('host changed');
    },
  });
  apply(makeCtx(registry), {});
  const tail = registry.sections.find((entry) => entry.name === 'lang-rule:tail');
  assertEqual(tail.order, DEFAULT_TAIL_ORDER, '回退尾锚 order');
});

test('config.tailOrder / requestOrder 可覆盖', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), { tailOrder: 123456, requestOrder: 777 });
  assertEqual(registry.sections.find((entry) => entry.name === 'lang-rule:tail').order, 123456, '覆盖尾锚 order');
  assertEqual(registry.contexts[0].order, 777, '覆盖 context order');
});

// ── 4. 配置化与 v1 向后兼容 ─────────────────────────────────────────
test('v1 兼容键 text / order / sectionName 继续有效', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), { text: '自定义铁律正文', order: -950, sectionName: 'my-lang-rule' });
  const head = registry.sections.find((entry) => entry.name === 'my-lang-rule');
  assert(head !== undefined, 'v1 sectionName 键应生效');
  assertEqual(head.order, -950, 'v1 order 键应生效');
  assertEqual(head.text, '自定义铁律正文', 'v1 text 键应生效');
});

test('headText / headOrder 覆盖 v2 键', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), { headText: 'v2 头锚', headOrder: -901 });
  const head = registry.sections.find((entry) => entry.name === 'lang-rule');
  assertEqual(head.order, -901, 'headOrder');
  assertEqual(head.text, 'v2 头锚', 'headText');
});

test('各锚可单独关闭：subagentEnabled / midEnabled / tailEnabled', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), { subagentEnabled: false, midEnabled: false, tailEnabled: false });
  assertEqual(registry.sections.length, 1, '只应剩头锚');
  assertEqual(registry.sections[0].name, 'lang-rule', '剩余的是头锚');
  assertEqual(registry.contexts.length, 1, 'per-request 通道不受 section 开关影响');
});

test('headEnabled=false 可单独关闭头锚，其余通道不受影响', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), { headEnabled: false });
  assertEqual(registry.sections.length, 3, '应剩子智能体/mid/尾三条');
  assert(!registry.sections.some((entry) => entry.name === 'lang-rule'), '头锚不应注册');
  assertEqual(registry.contexts.length, 1, 'per-request 通道仍注册');
});

test('requestTail=off 完全回到 v1 纯 section 行为', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), { requestTail: 'off' });
  assertEqual(registry.sections.length, 4, 'section 仍为 4 个');
  assertEqual(registry.contexts.length, 0, 'requestTail=off 时不得注册 context');
});

test('requestTail=false 与 requestEnabled=false 同样不注册 context（布尔等价形式）', () => {
  for (const config of [{ requestTail: false }, { requestEnabled: false }]) {
    const registry = makeRegistry();
    apply(makeCtx(registry), config);
    assertEqual(registry.sections.length, 4, `${JSON.stringify(config)} 时 section 仍为 4 个`);
    assertEqual(registry.contexts.length, 0, `${JSON.stringify(config)} 时不得注册 context`);
  }
});

test('enabled=false 不注册任何通道', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), { enabled: false });
  assertEqual(registry.sections.length, 0, 'section');
  assertEqual(registry.contexts.length, 0, 'context');
});

// ── 5. 降级路径：绝不抛异常 ─────────────────────────────────────────
test('systemPrompt 缺失：apply 不抛异常', () => {
  apply(makeCtx(null), {});
  apply({}, {});
  apply(undefined, {});
});

test('section()/context() 抛错：apply 不抛异常，其余通道继续注册', () => {
  const registry = makeRegistry({
    section() {
      throw new Error('duplicate section name');
    },
  });
  apply(makeCtx(registry), {});
  assertEqual(registry.sections.length, 0, 'section 全部失败');
  assertEqual(registry.contexts.length, 1, 'context 仍应注册成功');

  const registry2 = makeRegistry({
    context() {
      throw new Error('duplicate context name');
    },
  });
  apply(makeCtx(registry2), {});
  assertEqual(registry2.sections.length, 4, 'context 失败不影响 section');
  assertEqual(registry2.contexts.length, 0, 'context 失败');
});

test('logger 缺失：apply 不抛异常，注册照常', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry, { logger: false }), {});
  assertEqual(registry.sections.length, 4, 'section');
  assertEqual(registry.contexts.length, 1, 'context');
});

test('logger.info/debug 自身抛错：apply 不抛异常', () => {
  const registry = makeRegistry();
  const ctx = {
    systemPrompt: registry,
    logger: {
      info() {
        throw new Error('info boom');
      },
      debug() {
        throw new Error('debug boom');
      },
    },
  };
  apply(ctx, {});
  assertEqual(registry.sections.length, 4, 'section');
});

test('旧宿主无 systemPrompt.context()：degraded 到纯 section，不抛异常', () => {
  const registry = makeRegistry();
  delete registry.context;
  apply(makeCtx(registry), {});
  assertEqual(registry.sections.length, 4, 'degraded 模式下仍注册 4 个 section');
  assert(registry.contexts.length === 0, 'context 不可用');
});

test('config 为 null / 非对象时不抛异常', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), null);
  apply(makeCtx(registry), 'bad-config');
  assert(registry.sections.length >= 4, '仍按默认值注册');
});

// ── 6. per-request 去重（与宿主 supersession 判据对齐） ────────────
test('同一 step 固定文本只提交一次：3 个相同 step → 1 次 append', () => {
  const sections = [{ name: 'lang-rule:request-tail', text: REQUEST_TEXT }];
  const same = () => sections.map((entry) => `${entry.name}\u0000${entry.text}`);
  const sequence = [same(), same(), same()];
  let retained;
  let commits = 0;
  for (const next of sequence) {
    if (requestTailNeedsCommit(retained, next)) {
      commits += 1;
      retained = next;
    }
  }
  assertEqual(commits, 1, '固定文本应只提交一次');
});

test('requestTailNeedsCommit 语义：首次提交、相同跳过、变化重提、清除后重提', () => {
  assertEqual(requestTailNeedsCommit(undefined, ['a']), true, '首次');
  assertEqual(requestTailNeedsCommit(['a'], ['a']), false, '相同');
  assertEqual(requestTailNeedsCommit(['a'], ['b']), true, '变化');
  assertEqual(requestTailNeedsCommit(['a', 'b'], ['a']), true, '数量变化');
  assertEqual(requestTailNeedsCommit(['a'], []), true, '清空需提交');
  assertEqual(requestTailNeedsCommit(null, ['a']), true, '被清除后重新注入');
  assertEqual(requestTailNeedsCommit(undefined, []), false, '从未注入且无内容');
});

test('context provider 输出稳定（变体确定性循环，无随机）', () => {
  const registry = makeRegistry();
  let clock = 0;
  apply(makeCtx(registry), { contextVariant: 'step', now: () => clock });
  const provider = registry.contexts[0].text;
  assertEqual(typeof provider, 'function', 'step 模式必须是函数型变体 provider');
  const context = { agent: { id: 'step-agent' }, signal: {} };
  const sequence = [];
  for (let step = 0; step < 4; step += 1) {
    clock += 2000;
    sequence.push(REQUEST_VARIANTS.indexOf(provider(context)));
  }
  assertEqual(JSON.stringify(sequence), JSON.stringify([0, 1, 2, 0]), `step 模式应每 step 切换：${sequence}`);
  assertEqual(typeof registry.sections[3].text, 'string', '尾锚 text 必须是静态字符串');
});

// ── 7. per-request 证据检测（verify-installed 的 D 层判定） ────────────
test('D 层检测：source.kind 非 runtime-context 但正文含 REQUEST_TEXT 的 user 消息也算证据', () => {
  const event = {
    type: 'user/message',
    seq: 12,
    data: {
      role: 'user',
      source: { kind: 'agent-inbox' },
      content: [{ type: 'text', text: `<system-reminder>\n${REQUEST_TEXT}\n</system-reminder>` }],
    },
  };
  const evidence = detectRequestTailEvidence([event]);
  assertEqual(evidence.found, true, '应识别为 per-request 证据');
  assertEqual(evidence.via, 'user-system-reminder', '来源应标注 user-system-reminder');
  assertEqual(evidence.container, 'user-message/system-reminder', '应标注 system-reminder 包裹');
  assert(evidence.marker !== null, '应命中判据词');
});

test('D 层检测：runtime-context 快照（data 直接是消息体，无 message 包装）也能识别', () => {
  const event = {
    type: 'user/message',
    seq: 12,
    data: {
      role: 'user',
      id: 'x',
      source: {
        kind: 'runtime-context',
        form: 'snapshot',
        sections: [{ name: 'lang-rule:request-tail', text: REQUEST_TEXT }],
      },
      content: [{ type: 'text', text: `<system-reminder>\n${REQUEST_TEXT}\n</system-reminder>` }],
    },
  };
  const evidence = detectRequestTailEvidence([event]);
  assertEqual(evidence.found, true, '无 data.message 包装时也必须识别');
  assertEqual(evidence.via, 'user-system-reminder', '注入落地形态是 user 消息的 system-reminder');
  assertEqual(evidence.channel, 'runtime-context', '通道应记录 runtime-context');
  assertEqual(evidence.sectionNameSeen, true, '应看到 lang-rule:request-tail section');
  assertEqual(evidence.container, 'user-message/system-reminder', '应标注 system-reminder 包裹');
});

test('D 层检测：data.message.source 包装形态兼容（旧事件形状）', () => {
  const event = {
    type: 'user/message',
    seq: 5,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'user',
        source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'lang-rule:request-tail', text: REQUEST_TEXT }] },
        content: [{ type: 'text', text: `<system-reminder>\n${REQUEST_TEXT}\n</system-reminder>` }],
      },
    },
  };
  const evidence = detectRequestTailEvidence([event]);
  assertEqual(evidence.found, true, 'data.message.source 形态必须同样识别');
  assertEqual(evidence.via, 'user-system-reminder');
  assertEqual(evidence.sectionNameSeen, true);
});

test('D 层检测：无判据词的普通 user 消息不误报', () => {
  const events = [
    { type: 'user/message', seq: 3, data: { role: 'user', content: [{ type: 'text', text: '帮我跑一下测试' }] } },
    { type: 'system/message', seq: 4, data: { message: { role: 'system', content: [{ type: 'text', text: REQUEST_TEXT }] } } },
  ];
  const evidence = detectRequestTailEvidence(events);
  assertEqual(evidence.found, false, '普通 user 消息与 system 文本都不算 per-request 证据');
});

// ── 8. v3：可判定判据 / few-shot / step 级变体 / 两指标拆分 ─────────────
test('v3 判据可判定：要求「包含中文字符」且「不得以 ASCII 字母开头」', () => {
  for (const text of [REQUEST_TEXT, FIRST_SENTENCE_CLAUSE, TAIL_TEXT, MID_TEXT]) {
    assert(text.includes('包含中文字符'), `缺少可判定判据「包含中文字符」：${text.slice(0, 40)}`);
    assert(text.includes('不得以 ASCII 字母开头') || text.includes('不得是 ASCII 字母'), `缺少「不得以 ASCII 字母开头」：${text.slice(0, 40)}`);
  }
});

test('v3 黑名单降级为辅助提示，并标注枚举不完备', () => {
  assert(ENGLISH_OPENER_HINTS.includes('辅助提示'), '黑名单必须标注为辅助提示');
  assert(ENGLISH_OPENER_HINTS.includes('不完备'), '必须写明枚举永远不完备');
  assert(ENGLISH_OPENER_HINTS.includes('The user wants'), '必须覆盖实测漏网的 The user wants');
  assert(ENGLISH_OPENER_HINTS.includes('The task:'), '必须覆盖实测漏网的 The task:');
  // 黑名单不再是唯一判据：REQUEST_TEXT 里判据句必须在黑名单之前出现。
  const clauseIndex = REQUEST_TEXT.indexOf('包含中文字符');
  const blacklistIndex = REQUEST_TEXT.indexOf('辅助提示');
  assert(clauseIndex >= 0 && blacklistIndex > clauseIndex, '可判定判据必须排在黑名单之前');
});

test('v3 few-shot：2 个中文正确示范，总长 ≤60 字符，无英文示例', () => {
  assertEqual(FIRST_SENTENCE_FEW_SHOT.length, 2, '必须有 2 个示范');
  const total = FIRST_SENTENCE_FEW_SHOT.reduce((sum, text) => sum + text.length, 0);
  assert(total <= 60, `few-shot 总长 ${total} 超过 60`);
  for (const text of FIRST_SENTENCE_FEW_SHOT) {
    assert(text.startsWith('正确示范：'), `示范必须以「正确示范：」开头：${text}`);
    assert(/[\u4e00-\u9fff]/.test(text), `示范必须含中文：${text}`);
    assert(!/^(Let me|Let's|I'll|We need to|The user)/.test(text.replace('正确示范：', '')), `示范必须以中文起手：${text}`);
  }
});

test('v3 step 变体按调用序轮换，第 4 次回到第 1 个', () => {
  assertEqual(REQUEST_VARIANTS.length, 3, '必须有 3 个变体');
  const provider = createRequestVariantProvider('step');
  const seen = [provider(), provider(), provider()];
  assertEqual(new Set(seen).size, 3, 'step 模式前三次调用必须给出 3 个不同变体');
  assertEqual(provider(), seen[0], '第 4 次应回到第 1 个变体');
  for (const variant of REQUEST_VARIANTS) {
    assert(variant.includes('包含中文字符') || variant.includes('含中文字符'), `变体缺少可判定判据：${variant.slice(0, 30)}`);
  }
});

test('v3.1.1 lazy 按 step 计数：12 step × 3 次 assembly 调用仍是 0,0,0,1,1,1,2,2,2,0,0,0', () => {
  let clock = 0;
  const tracker = createStepAwareVariantProvider({
    mode: 'lazy',
    variants: REQUEST_VARIANTS,
    now: () => clock,
    sameStepWindowMs: 1500,
  });
  const perStepFirst = [];
  for (let step = 0; step < 12; step += 1) {
    const signal = { step }; // 同一 step 的多次调用共享 signal
    clock += 10;
    perStepFirst.push(tracker.text({ signal }));
    // 同一 step 内再调用 2 次（宿主 preStep assemble + step 内 refreshContext + 重试）
    clock += 10;
    const second = tracker.text({ signal });
    clock += 10;
    const third = tracker.text({ signal });
    assertEqual(second, perStepFirst[step], `第 ${step} step 内第 2 次调用必须同变体`);
    assertEqual(third, perStepFirst[step], `第 ${step} step 内第 3 次调用必须同变体`);
    clock += 2000; // 跨 step：模型请求耗时
  }
  const indexes = perStepFirst.map((text) => REQUEST_VARIANTS.indexOf(text));
  assertEqual(
    JSON.stringify(indexes),
    JSON.stringify([0, 0, 0, 1, 1, 1, 2, 2, 2, 0, 0, 0]),
    `lazy 的 step 序列不符：${indexes}`,
  );
  // 关键回归：调用次数被放大 3 倍，切换点仍是每 3 个 step，而不是每 3 次调用。
  const switches = indexes
    .map((value, index) => (index > 0 && value !== indexes[index - 1] ? index : null))
    .filter((value) => value !== null);
  assertEqual(JSON.stringify(switches), JSON.stringify([3, 6, 9]), `切换点不符：${switches}`);
});

test('v3.1.1 lazy 支持宿主 step/start 事件：每 step 两次调用序列仍正确', () => {
  let clock = 0;
  const tracker = createStepAwareVariantProvider({ mode: 'lazy', now: () => clock });
  const perStep = [];
  for (let step = 0; step < 12; step += 1) {
    tracker.noteStepStart();
    perStep.push(tracker.text({}));
    clock += 5;
    const again = tracker.text({});
    assertEqual(again, perStep[step], `第 ${step} step 的第二次调用必须同变体`);
    clock += 1000;
  }
  const indexes = perStep.map((text) => REQUEST_VARIANTS.indexOf(text));
  assertEqual(JSON.stringify(indexes), JSON.stringify([0, 0, 0, 1, 1, 1, 2, 2, 2, 0, 0, 0]));
});

test('v3.1.1 工具结果后下一步立即切「工具结果之后」变体（覆盖 mid 场景）', () => {
  let clock = 0;
  const tracker = createStepAwareVariantProvider({ mode: 'lazy', now: () => clock });
  tracker.noteStepStart(); // step 0（基础变体）
  assertEqual(tracker.text({}), REQUEST_VARIANTS[0], 'step 0 应是基础变体');
  tracker.noteStepStart(); // step 1（仍是基础变体，未到 3 步）
  assertEqual(tracker.text({}), REQUEST_VARIANTS[0], 'step 1 仍是基础变体');
  tracker.noteToolResult(); // step 1 里观察到工具结果
  tracker.noteStepStart(); // step 2
  assertEqual(
    tracker.text({}),
    REQUEST_VARIANTS[TOOL_RESULT_VARIANT_INDEX],
    '工具结果后的下一个 step 必须立即使用「工具结果之后」变体',
  );
  // 工具结果只消费一次：再下一步恢复按 step 轮换。
  tracker.noteStepStart(); // step 3
  assertEqual(tracker.text({}), REQUEST_VARIANTS[1], '恢复轮换：step 3 → floor(3/3)=1');
});

test('v3.1.2 off/step：off 固定文本，step 每 step 切换', () => {
  // off：字符串
  const offRegistry = makeRegistry();
  apply(makeCtx(offRegistry), { contextVariant: 'off' });
  assertEqual(typeof offRegistry.contexts[0].text, 'string', 'off 必须是固定字符串');
  // step：每 step 切换（同一 step 内多次调用保持同变体）
  const stepRegistry = makeRegistry();
  let clock = 0;
  apply(makeCtx(stepRegistry), { contextVariant: 'step', now: () => clock });
  const provider = stepRegistry.contexts[0].text;
  const context = { agent: { id: 'step-agent-2' }, signal: {} };
  const sequence = [];
  for (let step = 0; step < 4; step += 1) {
    clock += 2000;
    const first = REQUEST_VARIANTS.indexOf(provider(context));
    const second = REQUEST_VARIANTS.indexOf(provider(context)); // 同一 step 第二次调用
    assertEqual(second, first, `step 模式同一 step 内必须保持同变体（step ${step}）`);
    sequence.push(first);
  }
  assertEqual(JSON.stringify(sequence), JSON.stringify([0, 1, 2, 0]), `step 模式必须每 step 切换：${sequence}`);
});

test('v3.1.2 step 模式也接工具结果优先（t33 F1）', () => {
  let clock = 0;
  const tracker = createStepAwareVariantProvider({ mode: 'step', now: () => clock });
  tracker.noteStepStart(); // step 0
  assertEqual(tracker.text({}), REQUEST_VARIANTS[0], 'step 0 应是变体 1');
  tracker.noteToolResult(); // step 0 观察到工具结果
  tracker.noteStepStart(); // step 1
  assertEqual(
    tracker.text({}),
    REQUEST_VARIANTS[TOOL_RESULT_VARIANT_INDEX],
    'step 模式下工具结果后的下一个 step 也必须立即用「工具结果之后」变体',
  );
  tracker.noteStepStart(); // step 2
  assertEqual(tracker.text({}), REQUEST_VARIANTS[2], '恢复每 step 轮换：step 2 → variants[2]');
});

test('v3.1.1 lazy 按 agent 隔离：两个会话的 step 互不影响', () => {
  const registry = makeRegistry();
  let clock = 0;
  apply(makeCtx(registry), { contextVariant: 'lazy', now: () => clock });
  const provider = registry.contexts[0].text;
  const agentA = { agent: { id: 'agent-a' }, signal: {} };
  const agentB = { agent: { id: 'agent-b' }, signal: {} };
  const nextStep = (context) => {
    clock += 2000; // 跨 step：一次模型请求的耗时
    return REQUEST_VARIANTS.indexOf(provider(context));
  };
  // A 连跑 3 个 step：0,0,0
  const aSeq = [nextStep(agentA), nextStep(agentA), nextStep(agentA)];
  assertEqual(JSON.stringify(aSeq), JSON.stringify([0, 0, 0]), `agent A 序列：${aSeq}`);
  // B 是独立计数：它的第 1 个 step 仍是基础变体，不受 A 的 3 步影响
  assertEqual(nextStep(agentB), 0, 'agent B 的第一个 step 应仍是基础变体');
  // A 的第 4 个 step 切到变体 2（index 1）
  assertEqual(nextStep(agentA), 1, 'agent A 的第 4 个 step 应切到变体 2');
  // B 继续走自己的计数
  const bSeq = [nextStep(agentB), nextStep(agentB)];
  assertEqual(JSON.stringify(bSeq), JSON.stringify([0, 0]), `agent B 的前 3 个 step 都应是基础变体：${bSeq}`);
});

test('v3.1 normalizeContextVariant：off/step/lazy 三态与旧布尔兼容', () => {
  assertEqual(normalizeContextVariant(false), 'off', 'false → off');
  assertEqual(normalizeContextVariant('off'), 'off', "'off' → off");
  assertEqual(normalizeContextVariant(true), 'step', 'true → step（v3.0.0 行为）');
  assertEqual(normalizeContextVariant('step'), 'step', "'step' → step");
  assertEqual(normalizeContextVariant('lazy'), 'lazy', "'lazy' → lazy");
  assertEqual(normalizeContextVariant(undefined), 'lazy', '未设置 → lazy（v3.1 新默认）');
  assertEqual(normalizeContextVariant('bogus'), 'lazy', '非法值 → lazy');
});

test('v3.1 三档 preset：通道数与 token 预算', () => {
  assertEqual(DEFAULT_PRESET, 'full', '默认档必须是 full（与 v3.0.0 行为一致）');
  const expectations = {
    minimal: { sections: 1, contexts: 1, budget: 130 },
    standard: { sections: 4, contexts: 1, budget: 300 },
    full: { sections: 4, contexts: 1, budget: 400 },
  };
  for (const [name, expected] of Object.entries(expectations)) {
    const registry = makeRegistry();
    apply(makeCtx(registry), { preset: name });
    assertEqual(registry.sections.length, expected.sections, `${name} 的 section 数`);
    assertEqual(registry.contexts.length, expected.contexts, `${name} 的 context 数`);
    // token 估算 = 实际注册文本之和（context 取基础文本）。
    const parts = PRESETS[name].channels.map((channel) => (channel === 'context' ? PRESETS[name].texts.request : PRESETS[name].texts[channel]));
    const total = parts.reduce((sum, text) => sum + estimateTokens(text), 0);
    assert(total <= expected.budget, `${name} token 估算 ${total} 超过预算 ${expected.budget}`);
  }
  // minimal 只有 tail + context：不注册 head/subagent/mid。
  const minimalRegistry = makeRegistry();
  apply(makeCtx(minimalRegistry), { preset: 'minimal' });
  const minimalNames = minimalRegistry.sections.map((entry) => entry.name);
  assertEqual(JSON.stringify(minimalNames), JSON.stringify(['lang-rule:tail']), `minimal 应只注册尾锚：${minimalNames}`);
});

test('v3.1 preset 与 contextVariant 正交：可任意组合', () => {
  const combos = [
    ['minimal', 'off'],
    ['minimal', 'lazy'],
    ['standard', 'step'],
    ['standard', 'off'],
    ['full', 'lazy'],
    ['full', 'step'],
  ];
  for (const [preset, variant] of combos) {
    const registry = makeRegistry();
    apply(makeCtx(registry), { preset, contextVariant: variant });
    assert(registry.contexts.length === 1, `${preset}+${variant} 必须注册 context`);
    const isFunction = typeof registry.contexts[0].text === 'function';
    assertEqual(isFunction, variant !== 'off', `${preset}+${variant} 的 provider 形态（固定 vs 函数）`);
  }
});

test('v3.1 功能不缩水：minimal/standard 仍含可判定判据与 per-request 注入', () => {
  for (const preset of ['minimal', 'standard']) {
    const registry = makeRegistry();
    apply(makeCtx(registry), { preset });
    assertEqual(registry.contexts.length, 1, `${preset} 必须有 per-request 注入`);
    const text = typeof registry.contexts[0].text === 'function' ? registry.contexts[0].text() : registry.contexts[0].text;
    assert(/包含?中文字符/.test(text) || /含中文字符/.test(text), `${preset} 的 context 缺少可判定判据`);
    assert(text.includes('不得以 ASCII 字母开头'), `${preset} 的 context 缺少首字符判据`);
    const tail = registry.sections.find((entry) => entry.name === 'lang-rule:tail');
    assert(tail !== undefined, `${preset} 必须保留尾锚`);
    assert(/包含?中文字符/.test(tail.text) || /含中文字符/.test(tail.text), `${preset} 的尾锚缺少可判定判据`);
  }
  // standard 仍覆盖五通道
  const standardRegistry = makeRegistry();
  apply(makeCtx(standardRegistry), { preset: 'standard' });
  assertEqual(standardRegistry.sections.length, 4, 'standard 的 system 四锚');
  assertEqual(standardRegistry.contexts.length, 1, 'standard 的 per-request 注入');
  for (const name of ['lang-rule', 'lang-rule:subagent', 'lang-rule:mid', 'lang-rule:tail']) {
    assert(standardRegistry.sections.some((entry) => entry.name === name), `standard 缺少 ${name}`);
  }
});

test('v3 contextVariant 默认启用（注册函数型 provider），false 时回退固定文本', () => {
  const variantRegistry = makeRegistry();
  apply(makeCtx(variantRegistry), {});
  assertEqual(typeof variantRegistry.contexts[0].text, 'function', '默认应注册函数型变体 provider');

  const fixedRegistry = makeRegistry();
  apply(makeCtx(fixedRegistry), { contextVariant: false });
  assertEqual(typeof fixedRegistry.contexts[0].text, 'string', 'contextVariant=false 必须是固定文本');
  assertEqual(fixedRegistry.contexts[0].text, REQUEST_TEXT, '固定文本应等于 REQUEST_TEXT');

  const customRegistry = makeRegistry();
  apply(makeCtx(customRegistry), { requestText: '自定义尾约束' });
  assertEqual(customRegistry.contexts[0].text, '自定义尾约束', '显式 requestText 必须是固定文本');
});

test('v3 指标拆分：首句语言与整段 CJK 占比分别计算（首句中文 ≠ 整段中文）', () => {
  // 构造：首句中文，其后大量英文 —— 正是实测里「首句中文但 CJK 0.222」的形状。
  const text = `先确认工作区结构，再改代码。Here is a long English body that keeps going for many words and never returns to Chinese at all.`;
  const metrics = segmentMetrics(text);
  assertEqual(metrics.firstLanguage, 'zh', '首句应判为中文');
  assertEqual(metrics.firstSentenceIsZh, true, '首句指标独立记录');
  assert(metrics.cjkRatio < 0.2, `整段 CJK 比应低于 0.2，实际 ${metrics.cjkRatio}`);
  assertEqual(metrics.bodyIsZhDominant, false, '整段指标应判为非中文主导（与首句指标分离）');
  assertEqual(firstSentenceLanguage('The user wants a summary.'), 'en', '英文起手仍能被判为英文首句');
});

test('v3 判据实现锚文本第二条：ASCII 字母开头一律判英文（含混合起手）', () => {
  // 反例：ASCII 字母开头 + 后面有汉字，旧实现会误判 zh。
  assertEqual(firstSentenceLanguage('OK 我先确认工作区结构。'), 'en', 'OK 开头应判 en');
  assertEqual(firstSentenceLanguage('Sure 这一步先读文件。'), 'en', 'Sure 开头应判 en');
  assertEqual(segmentMetrics('OK 我先确认工作区结构。').firstSentenceIsZh, false, 'segmentMetrics 必须复用同一判据');
  // 四种实测英文起手（不依赖黑名单）。
  for (const text of [
    'The task: describe in four bullets what changed.',
    'Here is a quick summary of the changes.',
    'I will first inspect the workspace, then patch it.',
    'First, let me check the repository layout.',
  ]) {
    assertEqual(firstSentenceLanguage(text), 'en', `应判英文：${text}`);
  }
  // 中文正例（含 Markdown 装饰）。
  assertEqual(firstSentenceLanguage('先确认工作区结构，再改代码。'), 'zh', '纯中文首句');
  assertEqual(firstSentenceLanguage('**先读文件，再判断。**'), 'zh', '去装饰后以中文起手');
  // 装饰符本身不是 ASCII 字母，不应误判。
  assertEqual(firstSentenceLanguage('**OK 我先确认。**'), 'en', '去装饰后仍是 ASCII 开头');
});

test('v3 长任务分组：>10000 字符或 >10 段单独统计', () => {
  const long = { segments: 21, chars: 63443, cjkRatio: 0.15, firstLanguage: 'zh' };
  const short = { segments: 1, chars: 406, cjkRatio: 0.91, firstLanguage: 'zh' };
  const summary = summarizeLongTasks([long, short]);
  assertEqual(summary.long.sessions, 1, '长任务应单独计 1 个');
  assertEqual(summary.short.sessions, 1, '短任务 1 个');
  assertEqual(summary.long.bodyEnDominant, 1, '长任务整段英文主导应被单独计数');
  assertEqual(summary.long.firstSentenceEn, 0, '长任务首句英文单独计数');
  assertEqual(summary.threshold.chars, 10000, '字符阈值');
  assertEqual(summary.threshold.segments, 10, '段数阈值');
  // 阈值是「任一超过」，不是「同时超过」。
  assertEqual(summarizeLongTasks([{ segments: 11, chars: 100, cjkRatio: 0.5, firstLanguage: 'zh' }]).long.sessions, 1, '仅段数超阈值也算长任务');
  assertEqual(summarizeLongTasks([{ segments: 1, chars: 10001, cjkRatio: 0.5, firstLanguage: 'zh' }]).long.sessions, 1, '仅字符数超阈值也算长任务');
});

// ── 汇总 ────────────────────────────────────────────────────────────
console.log(`\nlang-rule selftest：通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure.label}: ${failure.error?.stack ?? failure.error}`);
  process.exit(1);
}
process.exit(0);
