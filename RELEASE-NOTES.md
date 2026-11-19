# Release Notes — dsh-lang-rule

> 说明：`v1.0.0` tag 打在初始提交 `f1e0acf`，`RELEASE-NOTES.md` 在 v1 发布后才进入 `main`，因此 v1 tag 树不含本文件，不是漏提交。`v2.0.0` 的 tag 打在包含本文件与 `CHANGELOG.md` 的最终提交上。
> 详细的逐项变更、实测数据与已知限制见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 2.0.0 — 2026-11-19

### 新增

- **per-request runtime-context 通道**（`lang-rule:request-tail`，context order `500`）：把同一句首句硬约束放进每一步重新渲染的请求尾部，落在本 step claimed 消息之后，是模型该次请求看到的最后一条消息。order 高于宿主内置 `WEB_SURFACE`（210）。
- **子智能体强化锚**（`lang-rule:subagent`，order `-880`）：显式点名 subagent / AgentTeams 成员 / workflow 子智能体 / 后台任务（审计显示子会话首句英文率 32.5% vs 主会话 10.9%）。
- **mid 段**（`lang-rule:mid`，order `5100`）：工具 schema 之后再重申一次首句约束，`midEnabled: false` 可关。
- **首句硬约束**：默认尾锚 A 版「第一句必须简体中文；不得以 Let me / Let's / I'll / We need to 起手；任务提示是英文也不豁免」，B/C 版作为候选导出。
- **order 运行时探测**：`getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')` / `getContextOrder('WEB_SURFACE')` 自适应宿主上界；探测失败回退常量（10200 / 210）。
- **工具**：`tools/selftest.mjs`（28 项断言）、`tools/selftest.test.mjs`（node:test）、`tools/verify-installed.mjs`（PASS/WARN/FAIL 三态 + `--json --strict --plugin --profile`）、`tools/lang-audit.mjs`（`--json`、逐段首句语言、按锚阶段分层）。
- **配置**：每锚独立开关与文本/order 覆盖；v1 的 `text` / `order` / `sectionName` 继续有效。

### 已知限制

- **旧宿主无 context API 时无 per-request 通道**：触发条件 `typeof ctx.systemPrompt.context !== 'function'`；表现是只剩 4 个 section、无请求尾注，`logger.debug` 记 `context-api-unavailable`；自查用 `tools/verify-installed.mjs --strict`。按裁决不实现 agent 侧 user 注入回退（会破坏消息序列/缓存/transcript，且全局作用域拿不到 agent 实例）。
- AgentTeams 英文任务分派模板不在本插件范围，插件只在提示词侧抵消。
- 首句约束是提示词层约束，不能保证每次都输出中文；量化验收以 `lang-audit --json` 的 `summary.byAnchorLayer` 为准。
- per-request 快照的去重单位是**整包 sections**：宿主自身 runtime context 变化时整包重发，尾注随之重复出现一次。

### 实测口径（快照 `2026-11-19T00:09Z` / `00:11Z`）

- headless 3 probe（`out/live.json`）：首句英文 **1/3 = 33.3%**，Wilson 95% 区间 **[6.1%, 79.2%]**；下界 6.1% 仍高于 5% 阈值，**未通过 <5% 判据**（0 失败需 n≈60）。
- desktop profile：`dsh-norefuse` 的 `includeRuntimeContext: false` 使 per-request 通道被抑制，v2 生效期 6 条 probe **0/6 有 runtime-context 事件**，实际运行为 4 个 section + mid。
- 历史语料零回归（`out/corpus.json`）：同哈希重算 **261** 个（drift 3），英文主导会话 **62 → 62**，中文主导率 **76.5% → 76.2%**（Δ −0.3pp）。
- 已知可绕过：`out/agent-probe-v2.json` 中 session `03d5a353` 以 `The task:` 开头（不在禁词表内），该会话首句与整段仍是英文。

## 1.0.0

- 初始版本：头部铁律锚（`-900`）+ 尾部锚（`90050`）+ `tools/lang-audit.mjs`。
