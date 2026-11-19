# Release Notes — dsh-zh-yayan

> **命名说明（2026-11-19 起）**：本文件 3.1.x / 3.0.0 / 2.0.0 段里的 `lang-rule:*` 是**当时的真实 section 名**，作为历史如实保留；
> 自改名为 `dsh-zh-yayan` 起，运行时标识统一为 `zh-yayan*`：
> `zh-yayan` / `zh-yayan:subagent` / `zh-yayan:mid` / `zh-yayan:tail` / `zh-yayan:request-tail`。
> 发布仓库的 `CHANGELOG.md` 1.0.0 段同理——其中的 `lang-rule:*` 是改名前的历史名，不是当前标识。


## 1.1.2 — 2026-11-19

### 加固：first-step 判定前移到工具变体之前（第三次同类型修复）

- `tracker.text()` 中 `stepIndex === 0 && firstStepText` 的判定**前移到 `toolStepActive` 之前**：step0 内即使已经出现 tool/result，也不得被「工具结果之后」变体覆盖。step1 起工具优先与轮换逻辑不变。
- 新增 `tools/firststep-gate.mjs`：**只读落盘的 `user/message` 原文**（不读 provider 返回值/preStep 日志），取 step0（第一个 `step/start` 之后）的第一条 request-tail，断言含「【首步】」+「先读」+四类禁起手清单；结果落盘 `out/firststep-gate.json`。

### 证据澄清（避免重复第三轮同类修复）

- t63 判「0/5 落盘」所用的 5 条会话（`636ea62f` 等）文件时间是 **22:27**，早于 t61 修复提交（约 22:50）；它们实测的仍是修复前行为，不能作为 t61 无效的证据。
- t61 之后产生的会话（如 `23247d2e`、`502b6d89`、`3ba34e7f`，22:52）的 step0 落盘原文已是「【首步】」。
- `tools/mid84-verdict.mjs` 的 firstStep 核对用 `MARKER = '【本步语言要求'` 过滤 user/message；**`【首步】` 文本不含该 marker**，会被跳过并回落到下一条（工具变体）→ 得出假阴性。建议其 firstStep 核对改为「step0 内第一条 request-tail，不按 marker 过滤」（本插件侧已在 `firststep-gate.mjs` 采用该口径）。

### 前置门（本任务验收）

- 修完跑 `--layer=live --count=5 --batch --types=mid`（隔离 DSH_HOME），5 条会话的 step0 落盘原文 **5/5** 含「【首步】」+ 四类禁起手（`out/firststep-gate.json`，pass=true）。
- 不变量未变：五通道 order、判据文本、三档预算 125/181/337、零 import、`firstStepVariant=false` 回退。

## 1.1.1 — 2026-11-19

### 修复：first-step 未落盘（preStep vs step/start 时序）

- **现象（t59）**：first-step 变体在真实会话里 0/57 落盘——假 ctx 的 selftest 过，真实宿主不过。
- **根因**：宿主时序是 `preStep assemble`（首次 → stepIndex=0，返回 first-step）→ `step/start` 触发 `noteStepStart()` → 旧实现无条件 `stepIndex += 1` → 推到 1；该 step 后续 `refreshContext()` 返回基础变体，而落盘的正是后者。first-step 只出现在不被持久化的 preStep 调用里。
- **修复**（`noteStepStart(stepNumber)`）：
  1. 事件带 1-based `step`（`step/start` 的 `data.step`）时，直接把 `stepIndex` 设为 `step-1`；与当前值相同则视为同一 step 的重复边界，不推进。
  2. 事件不带 step 号时，第一个 `step/start` 只认领、不推进，让同 step 的 `refreshContext` 仍命中 first-step；之后按序推进。
- **验证**：selftest 新增 3 条时序用例（真实时序 preStep→step/start(1)→refreshContext×3、无 step 号模式、重复边界不推进），62/62 通过；真实 probe 3 条 mid，step0 落盘文本 3/3 为 first-step（含「【首步】」与禁起手清单）。
- **不变**：lazy/step 轮换、工具结果优先、`firstStepVariant=false` 回退、五通道 order、判据文本、三档预算 125/181/337、零 import。

## 1.1.0 — 2026-11-19

### 新增：first-step 变体（针对 step0 的动作描述型英文起手）

- **问题定位（t56）**：mid 的失守点集中在 step 0——3/56 失败样本全部是「读文件之前的动作描述」：
  `The user wants me to read three specific files…` / `Need read three files.` / `I should start by reading…`。
  1.0.0 的「工具结果之后」变体在 tool/result 之后才生效，**结构上管不到 step0**。
- **修复**：新增 `FIRST_STEP_VARIANT`（110 字符，点估 65 token），只在 step 0（首次 assembly）注入一次：
  - 要求第一句先写**中文动作**（示范「先读这三个文件」「先看这几处字段」）；
  - 点名禁止 `The user wants` / `Need` / `I should` / `Let me` 起手；
  - 保留既有判据（必须含中文字符、不得以 ASCII 字母开头）。
- **不改变轮换**：step 1+ 恢复 `lazy = floor(step/3)%3`、`step = step%3`；工具结果优先（整个下一个 step 用变体 3）照旧。
- **可关闭**：`config.firstStepVariant = false` 完全回到 1.0.0 行为（A/B 与回滚）；`firstStepText` 可覆盖文本。
- **与 off 组合**：`contextVariant: off` + first-step 默认时，step0 用 first-step、step1 起固定 base（共 2 次 append）；要严格「只 append 一次」的 v2 行为需同时设 `firstStepVariant: false`。
- **成本**：只在 step0 注入一次，不增加长任务 per-step 开销；三档预算（125/181/337）不变。

### 不变

- 五通道 order（-900/-880/5100/90050/500）、四个既有 section 名、判据文本、三档 preset 预算、零内部 import。

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
