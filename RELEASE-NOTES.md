# Release Notes — dsh-lang-rule

## 3.1.3 — 2026-11-19

### 修复：工具结果变体被同 step 消费（t38 F1）

- 旧行为：`tool/result` 后的「下一次 provider 调用」返回变体 3（工具结果之后）。若该 step 在工具结果后还有 `refreshContext()` 调用，变体会在同一步被消费掉，下一个 step 已恢复轮换 —— t37 实测 long 会话命中率仅 **1/3**（`session-2a6b3aee` 3 个 tool/result 后分别是变体 1/2/0），而 mid 形态（读一个文件 → 同一步总结）恰恰最需要它。
- 新行为：`tool/result` 后**整个下一个 step 的所有调用**都返回变体 3，直到该 step 结束再恢复轮换（`pendingToolStep` → `toolStepActive` 两态，由 `beginStep()` 推进/清除）。lazy 与 step 两态一致。
- 新增 `tools/measure-tool-variant.mjs`：机制模拟（3/3 命中）、旧实现实测（真实会话 1/3）、`--replay` 用真实 step 序列 + 当前实现重放（`session-2a6b3aee` 10/10）。结果落盘 `out/tool-variant.json`。

### 文档：成本按实测校准（t38 F2）+ `now` 钩子说明（t38 F3）

- README 成本表 lazy 的 append/step 改为 **实测 0.479**（t37 多步会话，`V3.1.2-VERIFY.json#append.appendPerStepMultiStep`），并保留两条历史并说明差异：0.783（3.1.0 实测，按调用计数放大）、0.35（20 step × 2 调用模拟）、0.479（真实宿主调用节奏）；总体 0.606、单条 1 步会话 0.5 样本过小不作结论。
- README 工具段补 `settings.now` 假时钟钩子的用途与缺失影响（消除 3.1.2 的 static 1 WARN）：生产不设置，harness 用它构造确定性跨 step 序列。

### 不变

- 判据文本、五通道 order（-900/-880/5100/90050/500）、三档预算（125/181/337）均未改；零内部 import。

## 3.1.2 — 2026-11-19

### 修复：`step` 模式也接工具结果优先（t33 F1）

- `contextVariant: 'step'` 此前只做「每 step 轮换」，不监听 `tool/result`；工具结果后的下一个 step 首调用仍是 `variants[1]` 而不是「工具结果之后」的 `variants[2]`。现在 `lazy` 与 `step` 共用同一个 step 感知 tracker（仅 `mode` 不同），`step` 也监听 `session/event` 并在工具结果后的下一个 step 立即切变体 3，两态一致。
- `step` 的语义明确为「**每 step** 切换」（同一 step 内多次 assembly 调用保持同变体），不再随 provider 调用次数放大；README 配置表与成本表已同步。

### 文档：成本标签如实（t33 F2）

- README 成本表 `lazy` 的 `0.35` 明确标为「20 step 模拟」，并注明真实样本当前只有 1 条（0.5）；真实值需 v3.1.1+ 进 profile 后用新会话复测。
- 注明 `tools/measure-appends.mjs` 默认输出 `work/dsh-lang-rule/out/appends.json`，与 harness 侧 `work/lang-rule-tests/out/request-appends.json` 的路径差异，可用 `--out` 对齐。

### 不变

- 判据文本、五通道 order、三档 preset、`off` 语义均未改；`step` 与 `lazy` 的成本差异仍为「每步换」vs「每 3 步换」。

## 3.1.1 — 2026-11-19

### 修复：lazy 的成本节省没有兑现

- **根因**：宿主在一个 step 内可能多次调用 context provider（`preStep()` 的 `systemPrompt.assemble()`、step 内的 `refreshContext()`、失败重试）。v3.1 按「provider 调用次数」计数，`lazy` 被放大成「每 1–2 个 step 就切换」——t24 实测 long 组 `append/step = 0.783`，而设计预期是 0.33。
- **修复 1：按 step 计数**。新增 `createStepAwareVariantProvider`：优先监听宿主 `session/event` 的 `step/start`；事件不可用时退回「同一 signal + 距上次调用 <1500ms 视为同一 step」的时间窗启发式。构造 12 step × 3 次 provider 调用的假 ctx，变体序列仍是 `0,0,0,1,1,1,2,2,2,0,0,0`（每 3 step 切换）。
- **修复 2：工具结果后立即切换**。`tool/result` 之后的下一个 step 强制使用「工具结果之后」变体，不等 3 步轮换；直接覆盖 t24 暴露的 mid 场景（只读 1–2 个文件、2–3 段，5/15 = 33.3% 首句英文）。
- **新增 `tools/measure-appends.mjs`**：读真实会话统计 step 数、runtime-context append 次数与 append/step；`--dry-run` 做 20 step × 2 次调用的机制模拟。结果落盘 `out/appends.json`（observed / simulated / theory 三段）。
- **README 成本表重算**：`off 0.05` / `lazy 0.35`（模拟值，修复前实测 0.783）/ `step 1.00`，并写明「为什么 lazy 曾经没兑现」。

### 不变

- 判据文本（可判定首句）、五通道 order（-900/-880/5100/90050/500）、三档 preset 与 `off`/`step` 语义均未改；`contextVariant: step` 仍每次 assembly 切换。

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
