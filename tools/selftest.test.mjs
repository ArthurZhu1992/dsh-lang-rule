#!/usr/bin/env node
/**
 * selftest.test.mjs — node:test 最小单测（与 selftest.mjs 互补）。
 *
 * 覆盖两条 v2 新增的回归点：
 *   1. per-request 通道去重：固定文本在重复 step 上只提交一次；
 *   2. requestTail='off' 回退：行为回到 v1 的纯 section 版本（可做基线对比）。
 *
 * 运行：node --test tools/selftest.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, requestTailNeedsCommit, REQUEST_TEXT, TAIL_TEXT } from '../index.js';

/** 假注册表：记录 section/context 调用。 */
function makeRegistry(overrides = {}) {
  const sections = [];
  const contexts = [];
  return {
    sections,
    contexts,
    section(entry) {
      sections.push({ ...entry });
    },
    context(entry) {
      contexts.push({ ...entry });
    },
    getSectionOrder: () => 10200,
    getContextOrder: () => 210,
    ...overrides,
  };
}

/** 复刻宿主 RuntimeContextProjection.project() 的提交判定，只保留 append 决策。 */
function projectSteps(steps) {
  let retained;
  let commits = 0;
  for (const step of steps) {
    if (requestTailNeedsCommit(retained, step)) {
      commits += 1;
      retained = step;
    }
  }
  return commits;
}

const snapshot = (text) => [`lang-rule:request-tail\u0000${text}`];

test('per-request 去重：同一 step 固定文本只注入一次', () => {
  const one = snapshot(REQUEST_TEXT);
  assert.equal(projectSteps([one, one, one]), 1, '3 个相同 step 只应提交 1 次');

  // 模拟 compaction 后宿主清除再重注：中间夹一次空 sections。
  assert.equal(projectSteps([one, [], one]), 3, '清除后应重新注入');
});

test('per-request 去重：文本变化时必须重新提交', () => {
  assert.equal(projectSteps([snapshot('a'), snapshot('b')]), 2, '文本变化应重提');
  assert.equal(projectSteps([snapshot('a'), snapshot('a')]), 1, '文本相同不重提');
});

test('requestTail=off：完全不注册 context，回到 v1 纯 section 行为', () => {
  const registry = makeRegistry();
  apply({ systemPrompt: registry, logger: { info() {}, debug() {} } }, { requestTail: 'off' });
  assert.equal(registry.sections.length, 4, '四个 section 仍注册');
  assert.equal(registry.contexts.length, 0, '不得注册 per-request context');
  assert.ok(registry.sections.some((entry) => entry.text === TAIL_TEXT), '尾锚仍是 v1 同款首句约束');
});

test('默认（requestTail 未配置）：注册且只注册一个 per-request context', () => {
  const registry = makeRegistry();
  apply({ systemPrompt: registry, logger: { info() {}, debug() {} } }, {});
  assert.equal(registry.contexts.length, 1, '默认启用 per-request 通道');
  assert.equal(registry.contexts[0].name, 'lang-rule:request-tail');
  // v3：默认是 step 级变体 provider（函数），首个变体等于基础文本。
  assert.equal(typeof registry.contexts[0].text, 'function', 'v3 默认注册变体 provider');
  assert.equal(registry.contexts[0].text(), REQUEST_TEXT, '首个变体应等于基础文本');
  assert.equal(registry.contexts[0].interpolate, false);
  assert.equal(registry.contexts[0].required, true);
});

test('requestTail=off 与默认模式都不得抛异常（含 logger 缺失）', () => {
  for (const config of [{ requestTail: 'off' }, {}]) {
    const registry = makeRegistry();
    assert.doesNotThrow(() => apply({ systemPrompt: registry }, config));
    assert.doesNotThrow(() => apply({}, config));
    assert.doesNotThrow(() => apply(undefined, config));
  }
});

test('config 归一化：null / 字符串 / 空对象都按默认值注册', () => {
  for (const config of [null, 'bad-config', {}, undefined]) {
    const registry = makeRegistry();
    assert.doesNotThrow(() => apply({ systemPrompt: registry }, config));
    assert.equal(registry.sections.length, 4, `${String(config)} 时应有 4 个 section`);
    assert.equal(registry.contexts.length, 1, `${String(config)} 时应注册 1 个 context`);
  }
});

test('section order：头 -900 / 子 -880 / mid 5100 / 尾 ≥90050 / context 500', () => {
  const registry = makeRegistry();
  apply({ systemPrompt: registry, logger: { info() {}, debug() {} } }, {});
  const orderOf = (name) => registry.sections.find((entry) => entry.name === name)?.order;
  assert.equal(orderOf('lang-rule'), -900);
  assert.equal(orderOf('lang-rule:subagent'), -880);
  assert.equal(orderOf('lang-rule:mid'), 5100);
  assert.ok(orderOf('lang-rule:tail') >= 90050, '尾锚 order 必须 ≥90050');
  assert.equal(registry.contexts[0].order, 500);
  assert.ok(registry.contexts[0].order > 210, 'context order 必须大于宿主 WEB_SURFACE(210)');
});

test('同名 section 冲突让出：section() 抛错不中断，其余通道照常注册', () => {
  const registry = makeRegistry({
    section() {
      throw new Error('duplicate section name');
    },
  });
  assert.doesNotThrow(() => apply({ systemPrompt: registry }, {}));
  assert.equal(registry.sections.length, 0, '全部 section 注册失败');
  assert.equal(registry.contexts.length, 1, 'context 仍应注册成功');
});
