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
  SUBAGENT_TEXT,
  MID_TEXT,
  TAIL_TEXT,
  TAIL_CANDIDATES,
  REQUEST_TEXT,
  DEFAULT_HEAD_ORDER,
  DEFAULT_SUBAGENT_ORDER,
  DEFAULT_MID_ORDER,
  DEFAULT_TAIL_ORDER,
  DEFAULT_REQUEST_ORDER,
  HOST_SECTION_MAX_FALLBACK,
  HOST_CONTEXT_MAX_FALLBACK,
  requestTailNeedsCommit,
} from '../index.js';

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

test('尾锚含可判定硬约束：第一句=简体中文 + Let me/Let\'s/I\'ll/We need to + 英文提示不豁免', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), {});
  const tail = registry.sections.find((entry) => entry.name === 'lang-rule:tail');
  for (const keyword of ['第一句', '简体中文', 'Let me', "Let's", "I'll", 'We need to', '起手', '英文', '不豁免']) {
    assert(tail.text.includes(keyword), `尾锚缺少关键词：${keyword}`);
  }
  // 反向断言：不得出现「第一个字符」这种不可判定口径（首字符常是 ** 或反引号）。
  assert(!tail.text.includes('第一个字符'), '尾锚不得使用「第一个字符」口径');
  assert(!/如果|若|假如|除非/.test(tail.text), '尾锚不得包含条件从句');
});

test('per-request context 含同一组可判定硬约束', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), {});
  const request = registry.contexts[0];
  for (const keyword of ['第一句', '简体中文', 'Let me', "Let's", "I'll", 'We need to', '英文']) {
    assert(request.text.includes(keyword), `请求尾 context 缺少关键词：${keyword}`);
  }
  assertEqual(request.required, true, 'context 必须 required（部署关闭 runtime context 时依然生效）');
  assertEqual(request.interpolate, false, 'context 不得做 {{variable}} 插值');
});

test('默认尾锚是候选 A 版，且候选表至少 3 版', () => {
  assertEqual(TAIL_TEXT, TAIL_CANDIDATES.A, '默认尾锚必须是 A 版');
  assert(Object.keys(TAIL_CANDIDATES).length >= 3, '候选文本至少 3 版');
  for (const [key, text] of Object.entries(TAIL_CANDIDATES)) {
    assert(text.includes('Let me') && text.includes('第一句'), `候选 ${key} 缺少判据词`);
  }
});

test('长度预算：头 ≤250 / 子 ≤60 / mid ≤150 / 尾 ≤80 / 请求尾 ≤80 字符', () => {
  const budgets = [
    ['HEAD_TEXT', HEAD_TEXT, 250],
    ['SUBAGENT_TEXT', SUBAGENT_TEXT, 60],
    ['MID_TEXT', MID_TEXT, 150],
    ['TAIL_TEXT', TAIL_TEXT, 80],
    ['REQUEST_TEXT', REQUEST_TEXT, 80],
  ];
  for (const [label, text, limit] of budgets) {
    assert(text.length <= limit, `${label} 长度 ${text.length} 超过预算 ${limit}`);
  }
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

test('context 文本固定（静态字符串，无 provider 函数）以保证缓存友好', () => {
  const registry = makeRegistry();
  apply(makeCtx(registry), {});
  assertEqual(typeof registry.contexts[0].text, 'string', 'context.text 必须是静态字符串');
  assertEqual(typeof registry.sections[3].text, 'string', '尾锚 text 必须是静态字符串');
});

// ── 汇总 ────────────────────────────────────────────────────────────
console.log(`\nlang-rule selftest：通过 ${passed} 项，失败 ${failures.length} 项`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure.label}: ${failure.error?.stack ?? failure.error}`);
  process.exit(1);
}
process.exit(0);
