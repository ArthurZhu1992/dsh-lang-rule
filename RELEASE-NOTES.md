# Release Notes — dsh-lang-rule

## 3.1.0 — 2026-11-19

### 新增：token 预算（不改判据、不改通道）

- **三档 preset**（`config.preset`）：
  - `minimal`：只注册 tail + context（点估 125 token/请求，预算 ≤130），仍保留可判定首句判据与 per-request 注入；
  - `standard`：五通道 + 紧凑文本（无 few-shot，点估 181，预算 ≤300）；
  - `full`（默认）：五通道 + 完整文本 + few-shot（点估 337，预算 ≤400）。
- **变体策略三态**（`config.contextVariant`）：`off`（固定文本，宿主整包去重 → 只 append 一次，等同 v2 成本）/ `lazy`（**新默认**，每 3 次 assembly 切换，20 step 约 602 token）/ `step`（每次切换，v3.0.0 行为，20 step 约 1720 token）。旧布尔 `false`→`off`、`true`→`step` 继续有效。
- **可度量**：导出 `estimateTokens()`（中文 1 token/字、非中文 4 字符≈1 token 的保守估算）与 `PRESETS`；selftest 断言各档 token 预算、文本长度预算（HEAD ≤160 / SUBAGENT ≤60 / MID ≤110 / TAIL ≤60 / REQUEST ≤140）与 `lazy` 的 12 步切换序列。
- README 新增「token 成本」一节：常量成本表、三档对比、固定文本 vs `lazy` vs `step` 在 20 step 下的 append 次数与增量估算、选型建议。

### 不变

- 五通道 order：`-900 / -880 / 5100 / 90050 / 500`；不新增通道；零内部 import。
- 可判定判据与 few-shot 未削弱；`contextVariant: false` 仍可完全回到固定文本。

## 3.0.0 — 2026-11-19

### 变更（只改文本与 context provider，不改注入机制）

- **判据换轨**：首句约束从「禁止若干英文短语」改为可判定形态——`本步 reasoning 第一句必须包含中文字符（U+4E00–U+9FFF），不得以 ASCII 字母开头`。黑名单（`Let me / Let's / I'll / We need to / The user wants / The task:`）降级为辅助提示，文档标注**枚举永远不完备**（实测 `The user wants…`、`The task: …` 不在 v2 黑名单里）。
- **中文 few-shot**：2 个极短正确示范，总长 41 字符。
- **step 级变体**：`lang-rule:request-tail` 的文本在 3 个变体间轮换（基础 / 「包括这一句」/「工具结果之后」），对抗长任务稀释。`config.contextVariant = false` 回到固定文本。
- **指标拆分**：`lang-audit` 把「首句语言」与「整段 CJK 占比」分成两个独立指标，并按长任务（>10000 字符或 >10 段）分组；新增 `summary.firstSentenceVsBody`。
- **D 层检测修正**：`verify-installed` 兼容 `event.data.source` 与 `event.data.message.source` 两种事件形状（此前只读后者，误报 desktop 降级）。

### 不变

- 五通道 order：`-900 / -880 / 5100 / 90050 / 500`；不新增通道；不 import 任何 dsh/cordis 内部模块。
- 配置向后兼容：v1 的 `text/order/sectionName/tail*` 与 v2 的 `requestTail/requestEnabled/requestText` 继续有效。

### 已知限制

- 黑名单永远不完备：主判据已换成可判定形态，但英文起手仍可能以未枚举形式出现。
- 首句中文 ≠ 整段中文（实测 63,443 字符 / 21 段：首句中文但 CJK 0.222）；step 变体只是缓解稀释，不保证整段中文占比。
- step 变体每步多一条 73–137 字符快照，长任务有累计 token 成本，可 `contextVariant: false` 关闭。
- 旧宿主无 `context()` API 时无 per-request 通道（degraded 到 4 个 section）。

## 2.0.0 — 2026-11-19

### 新增

- **per-request runtime-context 通道**（`lang-rule:request-tail`，context order `500`）：把同一句首句硬约束放进每一步重新渲染的请求尾部，落在本 step claimed 消息之后，是模型该次请求看到的最后一条消息。order 高于宿主内置 `WEB_SURFACE`（210）。
- **子智能体强化锚**（`lang-rule:subagent`，order `-880`）：显式点名 subagent / AgentTeams 成员 / workflow 子智能体 / 后台任务（审计显示子会话首句英文率 32.5% vs 主会话 10.9%）。
- **mid 段**（`lang-rule:mid`，order `5100`）：工具 schema 之后再重申一次首句约束，`midEnabled: false` 可关。
- **首句硬约束**：默认尾锚 A 版「第一句必须简体中文；不得以 Let me / Let's / I'll / We need to 起手；任务提示是英文也不豁免」，B/C 版作为候选导出。
- **order 运行时探测**：`getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')` / `getContextOrder('WEB_SURFACE')` 自适应宿主上界；探测失败回退常量（10200 / 210）。
- **工具**：`tools/selftest.mjs`（28 项断言）、`tools/selftest.test.mjs`（node:test）、`tools/verify-installed.mjs`（PASS/FAIL + `--json --strict --plugin`）、`tools/lang-audit.mjs`（`--json`、逐段首句语言、按锚阶段分层）。
- **配置**：每锚独立开关与文本/order 覆盖；v1 的 `text` / `order` / `sectionName` 继续有效。

### 已知限制

- **旧宿主无 context API 时无 per-request 通道**：触发条件 `typeof ctx.systemPrompt.context !== 'function'`；表现是只剩 4 个 section、无请求尾注，`logger.debug` 记 `context-api-unavailable`；自查用 `tools/verify-installed.mjs --strict`。按裁决不实现 agent 侧 user 注入回退（会破坏消息序列/缓存/transcript，且全局作用域拿不到 agent 实例）。
- AgentTeams 英文任务分派模板不在本插件范围，插件只在提示词侧抵消。
- 首句约束是提示词层约束，不保证 100%；量化验收以 `lang-audit --json` 的 `summary.byAnchorLayer` 为准。
- per-request 快照的去重单位是**整包 sections**：宿主自身 runtime context 变化时整包重发，尾注随之重复出现一次。

## 1.0.0

- 初始版本：头部铁律锚（`-900`）+ 尾部锚（`90050`）+ `tools/lang-audit.mjs`。
