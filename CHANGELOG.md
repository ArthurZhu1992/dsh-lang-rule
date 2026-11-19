# Changelog

本文件记录 dsh-lang-rule 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
All notable changes to this project are documented here, in the spirit of Keep a Changelog and Semantic Versioning. Each entry is written once in Chinese and once in English.

## [3.1.3] — 2026-11-19

> 修复轮次记录：t37 实测发现「工具结果之后」变体命中率仅 1/3 → t38 修复（版本保持 3.1.3，不跳号）→ t39 审查 pass。**注入判据、五通道 order（`-900` / `-880` / `5100` / `90050` / `500`）与三档预算（125 / 181 / 337）均未变。**

### Fixed / 修复

- **工具结果变体的作用域提升到整个下一个 step**：旧实现只让「下一次 provider 调用」返回「工具结果之后」变体，若该 step 在 `tool/result` 之后还有 `refreshContext` 调用，变体在同一步被消费掉，下一个 step 已恢复轮换——t37 实测 long 会话命中率只有 **1/3**。现改为 `pendingToolStep → toolStepActive` 两态：`beginStep()` 在下一个 step 开始时激活，该 step 内所有 provider 调用都返回「工具结果之后」变体，直到再下一个 step 才清除；`lazy` 与 `step` 两态一致，`off` 不受影响。真实会话 `2a6b3aee` 重放 **10/10** 命中（对照旧实现 1/3），`6b2fa958`（1652 step）全 HIT。
- **`settings.now` 假时钟已文档化**：`apply(ctx, { now: () => clock })` 供 selftest/harness 构造确定性跨 step 序列，生产不设置；缺失时 static 层把时间窗行为记为「不可确定性验证」。3.1.2 的 static 层 1 条 WARN 由此消除（现 42 PASS / 0 FAIL / 0 WARN）。
- **复现说明**：`2a6b3aee` 的证据在隔离 DSH_HOME（`work/lang-rule-tests/.runtime/dsh-home/sessions`）；在默认 `~/.dsh/sessions` 下 `--replay --session 2a6b3aee` 会「未找到」。README 测量小节与脚本 usage 都写明必须带 `--sessions-root <path>`（或 `DSH_SESSIONS_ROOT`），并给出完整示例命令。

- **Tool-result variant now covers the whole next step**: previously only the next provider call returned the "after tool results" variant, which the same step's `refreshContext` consumed (t37 measured 1/3 hit rate). `pendingToolStep → toolStepActive` keeps the variant for every call in the following step, for both `lazy` and `step`; `off` is unaffected. Replay on real session `2a6b3aee`: **10/10**, versus 1/3 before.
- **`settings.now` test hook documented**; the static layer's single WARN from 3.1.2 is gone (42 PASS / 0 FAIL / 0 WARN).
- **Reproduction note**: `2a6b3aee` lives in the isolated DSH_HOME; pass `--sessions-root work/lang-rule-tests/.runtime/dsh-home/sessions` (or `DSH_SESSIONS_ROOT`), otherwise replay reports "not found".

### Cost table / 成本表（三条并列，来源不同）

| 数值 | 来源 | 含义 |
| --- | --- | --- |
| **0.35** | `measure-appends --dry-run` 的 20 step × 2 次调用**模拟** | 理想节奏下的下界 |
| **0.783** | 3.1.0 实测（t24 long 组） | 按 provider 调用次数计数，宿主一 step 多次调用把 lazy 放大 |
| **0.479** | **3.1.2 实测**（t37 多步会话，`out/V3.1.2-VERIFY.json#append.appendPerStepMultiStep`） | 真实宿主调用节奏下的当前基线 |

- **限定**：0.479 是 **3.1.2 的实测基线，不是 3.1.3 的定值**。3.1.3 把工具结果变体扩到整个下一个 step（命中率 1/3 → 3/3），理论上会让 lazy 成本略有抬高；部署 3.1.3 后需复跑 `node tools/measure-appends.mjs` 更新本表。总体（含 1 步短会话）为 0.606；单条 1 步会话（`03d5a353`）为 0.5，样本过小不作结论。

- **0.35** is a 20-step simulation (lower bound), **0.783** was the 3.1.0 measurement (inflated by counting provider calls), and **0.479** is the **3.1.2** multi-step baseline. 0.479 is not 3.1.3's number: widening the tool-result variant slightly raises lazy cost, so re-run `measure-appends` after deploying 3.1.3.

### Not claimed / 不声称

- **不声称达标**：t37 的 mid 组 20%（n=5）样本量不足以证明改善；3.1.3 的机制修复目标是「让命中率与成本可解释」，不是「已把首句英文压到 5% 以下」。
- 历史结论仍然有效：t24 的 10.7%（n=75）是 lazy 近似 step（0.783）条件下的成绩，不能当作 3.1.3 的成绩。

- **No success claim**: t37's mid group at 20% (n=5) is too small to demonstrate improvement; 3.1.3 makes hit rate and cost explainable, not "first-sentence English below 5%".
- t24's 10.7% (n=75) was measured under near-step lazy behavior and is not 3.1.3's result.

### Compatibility / 兼容性

- `contextVariant` 三态与旧布尔映射不变；三档 preset 预算未变；v1 / v2 配置键继续有效。

- The three `contextVariant` modes, legacy boolean mapping, and preset budgets are unchanged; v1 / v2 config keys keep working.

## [3.1.2] — 2026-11-19

> 合并 3.1.1 与 3.1.2 的修复发布（3.1.1 未单独打 tag）。**注入判据、五通道 order（`-900` / `-880` / `5100` / `90050` / `500`）与三档预算均未变。**

### Fixed / 修复

- **lazy 计数单位改为 step**：旧实现按 provider 调用次数计数，而宿主一次 step 内可能多次调用（preStep assemble、step 内 refreshContext、重试），t24 实测 long 组 append/step = **0.783**（设计期望 0.33）。现改为 `createStepAwareVariantProvider`：优先监听 `session/event` 的 `step/start`；事件不可用时退回「同一 signal + 间隔 < 1500ms 视为同一 step」的时间窗；并按 `agent.id` 分桶，避免多会话 step 串扰。
- **step 模式也接入工具结果优先**：lazy 与 step 合并到同一分支，共享 tracker，`tool/result` 之后的下一个 step 强制返回「工具结果之后」变体（`TOOL_RESULT_VARIANT_INDEX = 2`），消费一次后恢复轮换。目标是覆盖 t24 里 mid 组 33.3% 的失守场景。
- **新增 `tools/measure-appends.mjs`**：读真实会话输出 step / append / append-per-step；`--dry-run` 做 20 step × 2 次调用模拟；结果默认落 `out/appends.json`，可用 `--out` 对齐 harness 侧路径。

- **lazy counts steps, not provider calls**: the host may call the provider several times per step, which inflated appends to **0.783/step** in t24 (design assumed 0.33). `createStepAwareVariantProvider` now listens for `session/event` `step/start`, falls back to a 1500ms same-step time window, and buckets by `agent.id`.
- **step mode also honours tool results**: both modes share the tracker; the step after a `tool/result` returns the "after tool results" variant (`TOOL_RESULT_VARIANT_INDEX = 2`) once, then resumes rotation. This targets the mid-group failure seen in t24.
- **New `tools/measure-appends.mjs`**: reports step / append / append-per-step from real sessions; `--dry-run` simulates 20 steps × 2 calls. Output defaults to `out/appends.json`; `--out` aligns it with the harness path.

### Cost table / 成本表（模拟与实测分开列）

| 模式 | append/step（模拟，20 step × 2 调用） | 真实样本 | 20 step 成本（full 档，context 点估 86） |
| --- | --- | --- | --- |
| `off`（固定文本，整包去重） | 0.05 | 未单独测量 | ≈86 token（1 次 append） |
| `lazy`（默认，每 3 个 step 切换 + 工具结果优先） | **0.35（20 step 模拟）** | **n=1，0.5**（`03d5a353`，v2 固定文本期，不能代表 3.1.2） | ≈602 token（7 次） |
| `step`（每 step 切换） | 1.00 | 未单独测量 | ≈1720 token（20 次） |

- **口径说明**：`0.35` 来自 `measure-appends --dry-run` 的 20 step × 2 次调用**模拟**，不是真实会话实测；当前真实样本只有 `03d5a353` 一条（append/step 0.5，属于 v2 固定文本期）。修复前 t24 的 long 组 **0.783** 是唯一真实基线。3.1.2 装进 profile 后需用新会话批量复测（`node tools/measure-appends.mjs`，非 dry-run），复测后再更新本表。
- **3.1.0 的历史假设保留**：3.1.0 的成本表按「每 3 次 assembly 切换 ≈ 1/3」估算 lazy ≈602 token；t24 实测 0.783 证明该假设不成立。本表不删除这条历史说明。

### Boundary / 边界

- t24 的 n=75、首句英文 **10.7%**（Wilson [5.5%, 19.7%]）是在 **lazy 退化为近似 step（append/step 0.783）** 的条件下测得的，**不等于 3.1.2 的 lazy（模拟 0.35）+ 工具结果后切换**的效果。3.1.2 的组合效果正在单独复测（short 20 + mid 15）；结果出来前，请勿把 10.7% 当作 3.1.2 的成绩。
- t24 的 mid 组 33.3% 尚未被新机制验证；本次发布**不声称 mid 已改善**。

- t24's n=75 and 10.7% first-sentence English were measured while lazy degraded to near-step behavior (0.783 append/step). They **do not represent 3.1.2's lazy (0.35 simulated) + tool-result switching**. A separate re-test (short 20 + mid 15) is running; until it lands, 10.7% is not 3.1.2's result.
- The mid-group 33.3% from t24 has not been validated under the new mechanism; this release **does not claim mid improvement**.

### Compatibility / 兼容性

- `contextVariant` 三态（`off` / `lazy` / `step`）与旧布尔映射不变；三档 preset 预算 125 / 181 / 337 未变；v1 / v2 配置键继续有效。

- The three `contextVariant` modes and legacy boolean mapping are unchanged; preset budgets (125 / 181 / 337) are unchanged; v1 / v2 config keys keep working.

## [3.1.0] — 2026-11-19

> 定位：token 预算可配置、可度量；判据与通道零改动（`index.js` 变化仅为文本常量与 preset 分支，五通道 order 仍 `-900` / `-880` / `5100` / `90050` / `500`）。

### Added / 新增

- **三档 preset**（`config.preset`，默认 `full`）：

  | 档 | 通道 | 字符 | token 点估 | 预算 |
  | --- | --- | --- | --- | --- |
  | `minimal` | tail + context | 188 | 125 | ≤130 |
  | `standard` | 五通道（紧凑文本，无 few-shot） | 240 | 181 | ≤300 |
  | `full`（默认） | 五通道（完整文本 + few-shot） | 506 | 337 | ≤400 |

- **变体三态**（`config.contextVariant`，默认 `lazy`）：`off` 固定文本（只 append 一次，等同 v2 成本）；`lazy` 每 3 次 assembly 切换（实测 12 步序列 `0,0,0,1,1,1,2,2,2,0,0,0`）；`step` 每次切换（v3.0.0 行为）。旧布尔兼容：`false → off`、`true → step`。
- **20 step 成本对比**（full 档，context 点估 86）：v2 固定 ≈86 token → v3 lazy ≈602（7 次）→ v3 step ≈1720（20 次）；standard+lazy ≈238、minimal+lazy ≈602。
- **selftest 45 项**：新增三档预算、lazy 序列、三态归一化、正交组合、功能不缩水、长度预算六组断言。

- **Three presets** (`config.preset`, default `full`): `minimal` 125 tokens (≤130), `standard` 181 (≤300), `full` 337 (≤400), measured with `estimateTokens`.
- **Three variant modes** (`config.contextVariant`, default `lazy`): `off` / `lazy` (switch every third assembly) / `step` (switch every assembly). Legacy booleans map `false → off`, `true → step`.
- **Cost for 20 steps** (full, context ≈86 tokens): v2 fixed ≈86, v3 lazy ≈602 (7 appends), v3 step ≈1720 (20 appends); standard+lazy ≈238, minimal+lazy ≈602.
- **selftest now 45 assertions**, including preset budgets, lazy sequence, normalization, orthogonal combinations, feature parity, and text-length budgets.

## [3.0.0] — 2026-11-19

> 定位：把「禁止英文起手短语」换成可判定判据，并为长任务与子智能体补上上下文中段与逐 step 变体。**注意：t24 的批量实测结论是「无显著变化」且未达到 5% 目标，见下方 Verified 段。**

### Added / 新增

- **可判定首句判据**：第一句必须包含中文字符（U+4E00–U+9FFF），且不得以 ASCII 字母开头。原黑名单降级为 `ENGLISH_OPENER_HINTS` 辅助提示（枚举永远不完备），文档写明不得作为唯一判据。
- **2 条中文 few-shot**：总长 41 字符（≤60），无英文示例，避免把「英文示例」当成可模仿的起手。
- **step 级上下文变体**：`REQUEST_VARIANTS` 3 版（基础 / 包括这一句 / 工具结果之后），按 assembly 轮换，令整包 sections 每步不同，从而绕过宿主的整包去重、对抗长任务稀释；`contextVariant: false` 回退固定文本（等同 v2）。
- **双指标与长任务分组**：`tools/lib/lang-metrics.mjs` 的 `segmentMetrics()` 同时输出首句语言与整段 CJK（`firstSentenceIsZh` / `bodyIsZhDominant` 独立字段）；`lang-audit --json` 新增 `summary.firstSentenceVsBody` 与 `summary.longTasks`（按 >10000 字符或 >10 段分 long/short）。

- **Decidable first-sentence rule**: the first sentence must contain a CJK character (U+4E00–U+9FFF) and must not start with an ASCII letter. The old phrase blacklist is demoted to `ENGLISH_OPENER_HINTS` (a hint, never a complete enumeration).
- **Two Chinese few-shot examples** (41 characters total, ≤60), no English example.
- **Per-assembly context variants**: three `REQUEST_VARIANTS` rotate per assembly so the whole section bundle differs each step, defeating whole-bundle deduplication on long tasks; `contextVariant: false` falls back to fixed text (= v2).
- **Dual metrics and long-task grouping**: `segmentMetrics()` reports first-sentence language and body CJK separately; `lang-audit --json` adds `summary.firstSentenceVsBody` and `summary.longTasks`.

### Verified / 实测（t24，真实数据，不美化）

- **批量 probe**：隔离 headless profile，75 条独立 probe（short 45 / mid 15 / long 15），配置 `preset=full`、`contextVariant=lazy`。
- **首句英文 8/75 = 10.7%**，Wilson 95% **[5.5%, 19.7%]**；v2 参考（n=16）25.0% `[10.2%, 49.5%]`。Δ −14.3pp，但**区间重叠 → 按既定口径判定为「无显著变化」**；下界 5.5% 仍高于 5%，**未达到 5% 目标**。
- **分组**：short `1/45 = 2.2%` `[0.4%, 11.6%]`（CJK 0.838）；mid `5/15 = 33.3%` `[15.2%, 58.3%]`（CJK 0.420）；long `2/15 = 13.3%` `[3.7%, 37.9%]`（CJK 0.360，工具调用均值 23.9）。
- **历史语料无回归**：261 会话重算中文主导 76.2%（−0.3pp），英文主导 62（不变）；static 层 42 PASS / 0 FAIL。
- **两个机制缺口（未修）**：① mid 组 33.3% 是新的失守高发区——只读 1 个文件、2–3 段的形态里工具结果紧贴采样点，而「工具结果之后」变体通常要到第 3 次 assembly 才轮到；② `lazy` 的成本节省未兑现——`out/request-appends.json` 实测 long 组 append/step = 0.783（13.1 步平均 10.3 次 append），推断宿主每次 assembly 多次调用 provider，按调用计数的 lazy 被放大。
- 成本：short 16.7s / 280 token、mid 37.3s / 1,342、long 265.9s / 14,429；75 条约 1.8 小时 / 249k token。

- **Batch probes**: isolated headless profile, 75 independent probes (short 45 / mid 15 / long 15) with `preset=full`, `contextVariant=lazy`.
- **First-sentence English 8/75 = 10.7%**, Wilson 95% **[5.5%, 19.7%]**; v2 reference (n=16) 25.0% `[10.2%, 49.5%]`. Δ −14.3pp but **overlapping intervals → judged "no significant change"**; the lower bound (5.5%) is still above 5%, so **the target was not met**.
- **Groups**: short `1/45 = 2.2%`, mid `5/15 = 33.3%`, long `2/15 = 13.3%`.
- **No historical-corpus regression**: 261 sessions recomputed, Chinese-dominated 76.2% (−0.3pp), English-dominated 62 (unchanged); static layer 42 PASS / 0 FAIL.
- **Two known gaps (unfixed)**: (1) the mid group is now the weak spot (33.3%) because tool results sit right next to the sampling point; (2) the `lazy` cost saving did not materialize (append/step = 0.783 on the long group).
- Cost: 16.7s / 280 tokens (short), 37.3s / 1,342 (mid), 265.9s / 14,429 (long); about 1.8 hours and 249k tokens for 75 probes.

### Compatibility / 兼容性

- v1 / v2 的配置键继续有效（`text`、`order`、`sectionName`、`tailText`、`tailOrder`、`tailSectionName`、`tailEnabled`）；新键 `preset`、`contextVariant` 均有默认值。
- 五通道 order 未变；`index.js` 零 import。

- v1 / v2 configuration keys keep working; new `preset` and `contextVariant` keys default to `full` / `lazy`.
- The five channel orders are unchanged; `index.js` has no imports.

## [2.0.1] — 2026-11-19

> 定位：**文档与检测工具修正；注入行为与 2.0.0 完全相同**（`index.js` 未改，sha256 `49e8918552a9b8e82270084e5d713eb930f826650a39a8907045052a4f0c1e06`）。
> 对账提示：`v2.0.0` tag 树内的 `CHANGELOG.md` 仍是发布时的旧数字（headless 2/3、重算 262、中文主导 76.3%，以及「desktop 被 `includeRuntimeContext:false` 抑制」的错误结论）；本文件是 2.0.1 起的修正版。拿 tag 与 `main` 对账时，以本条说明为准。`v2.0.1` tag 树内为本修正版；`main` 之后的文档小修（版本号、自查项命名）属文档提交，不改变注入行为。

### Fixed / 修复

- **per-request 通道检测假阴性**：`tools/verify-installed.mjs` 旧版只读 `data.message.source`，而 dsh 0.2.2 的 runtime-context 快照落在 `data.source`（`data = { role, content, source }`），已生效的通道因此被误报为 degraded。现统一解包 `data.message` 与 `data` 两种形态，同时接受 `source.kind === 'runtime-context'` 与正文判据词两类证据，并输出 `via=user-system-reminder`；新增纯函数模块 `tools/lib/request-tail-detect.mjs`。
- **撤回 2.0.0 文档里的错误结论**：「desktop 被 `includeRuntimeContext: false` 抑制、0/6 会话无 runtime-context、实际 4 section + mid」是假阴性导致的误判，已改为「desktop 上生效，4 section + 1 context」。
- **数字更正**：headless 首句英文 `2/3` → **1/3 = 33.3%**（Wilson 95% `[6.1%, 79.2%]`，`out/live.json` 快照 `2026-11-19T00:09Z`）；语料重算 `262` → **261**（drift 3）、中文主导 `76.3%` → **76.2%**（`out/corpus.json` 快照 `2026-11-19T00:11Z`）。
- **probe 引用**：`probe-e` 统一改为「会话前缀 `03d5a353` + `out/agent-probe-v2.json`」。

### Changed / 变更

- `tools/selftest.mjs`：28 项 → **32 项**（新增 D 层检测用例：`data.message` 与 `data` 两种形态都能命中、普通 user 消息不误报等）。
- README、RELEASE-NOTES 的 desktop 段落同步改为「生效，不是降级；只有旧宿主无 `systemPrompt.context()` 才降级」。

### Verified / 实测

- `node tools/verify-installed.mjs` → **PASS**（已安装 profile 模式）：`per-request 约束出现在会话里（3/10 个会话；v2 安装后新会话 8 个）`，`来源 user-system-reminder×3`；样例 `03d5a353 … via=user-system-reminder channel=runtime-context section=lang-rule:request-tail`。用 `--plugin` 指向未安装副本时，「v2 安装后新会话」计数为 0、不判 FAIL，属正常模式差异。
- `out/agent-probe-v2.json`（正确事件路径重算）：10 条 probe、**7 条** `containsLangRuleRequestTail: true`、`runtimeContextEvents` 合计 16。
- `node tools/selftest.mjs` 32/32、`node --test tools/selftest.test.mjs` 8/8。

### Compatibility / 兼容性

- 配置键与注入行为不变；v1 / 2.0.0 的部署无需改动。

### Known issues / 已知问题

- **`v2.0.1` tag 树与 `main` 的文档差异**：`v2.0.1` tag（`6791327`）内的 `README.md` 版本行仍写 `2.0.0`，自查项名仍是旧文案「per-request 约束出现在 runtime-context」；这两处已在 `main` 的后续文档提交修正。差异仅限文档：`index.js` 未变（sha256 `49e8918552a9b8e82270084e5d713eb930f826650a39a8907045052a4f0c1e06`），注入行为相同。
- **`v2.0.0` tag 树内的 `CHANGELOG.md`** 仍是发布时的旧数字与旧结论（见上方对账提示）；2.0.1 起以 `main` 上的 `CHANGELOG.md` 为准。

- **Documentation-only difference between the `v2.0.1` tag tree and `main`**: inside tag `v2.0.1` (`6791327`), `README.md` still shows version `2.0.0` and the old self-check item name; both were corrected in follow-up documentation commits on `main`. The difference is documentation only — `index.js` is unchanged (`49e8918552a9b8e82270084e5d713eb930f826650a39a8907045052a4f0c1e06`) and injection behavior is identical.
- **The `CHANGELOG.md` inside tag `v2.0.0`** still carries the old numbers and conclusions (see the reconciliation note above); from 2.0.1 onward, the `CHANGELOG.md` on `main` is authoritative.

### English summary

- **Per-request detection false negative fixed**: `tools/verify-installed.mjs` used to read only `data.message.source`; dsh 0.2.2 runtime-context snapshots live in `data.source` (`data = { role, content, source }`), so a working channel was reported as degraded. It now unwraps both shapes, accepts `source.kind === 'runtime-context'` or the marker text, and reports `via=user-system-reminder`; new pure module `tools/lib/request-tail-detect.mjs`.
- **Retracted the wrong 2.0.0 conclusion**: "desktop suppressed by `includeRuntimeContext: false`, 0/6 sessions, 4 sections + mid" was a detection false negative; desktop actually runs 4 sections + 1 context.
- **Figures corrected**: headless first-sentence English `2/3` → **1/3 = 33.3%** (Wilson 95% `[6.1%, 79.2%]`, `out/live.json` 2026-11-19T00:09Z); corpus recomputed `262` → **261** (drift 3), Chinese-dominated `76.3%` → **76.2%** (`out/corpus.json` 2026-11-19T00:11Z).
- **Probe reference**: `probe-e` → session prefix `03d5a353` + `out/agent-probe-v2.json`.
- `selftest.mjs` 28 → **32** assertions; `verify-installed` reports PASS with `via=user-system-reminder`; the recomputed `agent-probe-v2.json` shows **7/10** probes with `containsLangRuleRequestTail: true` and 16 runtime-context events.
- Injection behavior is identical to 2.0.0 (`index.js` unchanged, same sha256).

## [2.0.0] — 2026-11-19

### Added / 新增

- **五通道注入**，前四条是 system prompt section，第五条是每请求重新渲染的 runtime context：
  - `head` `lang-rule` @ `-900`：长版铁律（head anchor）。
  - `subagent` `lang-rule:subagent` @ `-880`：显式点名 subagent / AgentTeams 成员 / workflow 子智能体 / 后台任务（subagent anchor）。
  - `mid` `lang-rule:mid` @ `5100`：工具 schema（`TOOLS_SDK = 5000`）之后重申一次首句约束（mid anchor）。
  - `tail` `lang-rule:tail` @ `90050`：尾部首句锚，排在全部宿主 section（上界 `DEPLOYMENT_PERSONA_SUFFIX = 10200`）之后（tail anchor）。
  - `request` `lang-rule:request-tail` @ `500`：per-request runtime-context，注册为 `required: true`，每请求重新渲染并 append 在 claimed 消息之后（per-request channel）。
- **工具链**：
  - `tools/selftest.mjs`：28 项注册契约断言，退出码 0 = 全过。
  - `tools/selftest.test.mjs`：`node:test` 8 项（per-request 去重、`requestTail=off` 回退、config 归一化、order 断言、同名 section 冲突让出）。
  - `tools/verify-installed.mjs`：PASS / WARN / FAIL 三态，支持 `--strict`、`--json`、`--plugin <目录>`、`--profile <name>`。
  - `tools/lang-audit.mjs`：新增 `--json`，输出逐段首句语言、首个英文段，并按锚阶段（none / head / head+tail / head+tail+request 等）分层统计。
- **配置**：每个锚点都有独立的开关与文本/order 覆盖键（`headEnabled`、`subagentText`、`midOrder`、`tailText`、`requestTail` 等，完整表见 README）。

- **Five injection channels** — four system-prompt sections plus one per-request runtime context:
  - `head` `lang-rule` @ `-900`: the full language rule.
  - `subagent` `lang-rule:subagent` @ `-880`: names subagents, AgentTeams members, workflow subagents and background jobs explicitly.
  - `mid` `lang-rule:mid` @ `5100`: restates the first-sentence rule after the tool schemas (`TOOLS_SDK = 5000`).
  - `tail` `lang-rule:tail` @ `90050`: tail anchor after every host section (host upper bound `DEPLOYMENT_PERSONA_SUFFIX = 10200`).
  - `request` `lang-rule:request-tail` @ `500`: per-request runtime context registered with `required: true`, re-rendered every request and appended after the claimed messages.
- **Tooling**: `tools/selftest.mjs` (28 assertions), `tools/selftest.test.mjs` (`node:test`, 8 tests), `tools/verify-installed.mjs` (PASS/WARN/FAIL plus `--strict`, `--json`, `--plugin`, `--profile`), `tools/lang-audit.mjs` (`--json` with per-segment first-sentence language and anchor-layer breakdown).
- **Configuration**: independent switches and text/order overrides per anchor (`headEnabled`, `subagentText`, `midOrder`, `tailText`, `requestTail`, …; full table in README).

### Changed / 变更

- **尾锚默认文本改为硬约束候选 A**：「第一句必须简体中文；不得以 Let me / Let's / I'll / We need to 起手；任务提示是英文也不豁免」。B / C 两个候选仍由 `index.js` 导出，可用 `tailText` 指定。
- **order 改为运行时探测**：用 `registry.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')` 与 `registry.getContextOrder('WEB_SURFACE')` 取宿主上界，尾锚取 `max(90050, 上界 + 1000)`、per-request 取 `max(500, 上界 + 100)`；探测方法缺失或抛错时回退到实测常量 `10200` / `210`。
- **per-request 通道默认开启**，可用 `requestTail: 'off'` 或 `requestEnabled: false` 关闭，行为完全回到 v1 的纯 section 版本（回归对照用）。

- **Tail anchor defaults to hard-constraint candidate A**: "the first sentence must be Simplified Chinese; must not start with Let me / Let's / I'll / We need to; an English task prompt is not an exemption". Candidates B and C are still exported and can be selected via `tailText`.
- **Orders are probed at runtime** through `getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')` and `getContextOrder('WEB_SURFACE')`, with fallbacks to the measured constants `10200` / `210`.
- **The per-request channel is on by default**; `requestTail: 'off'` or `requestEnabled: false` restores the v1 section-only behavior for regression comparison.

### Fixed / 修复

- **文档表述**：此前把 runtime-context 快照的行为写成「replace」，与宿主实现不符——宿主 `RuntimeContextProjection.project()` 做的是整包比较后 **append** 新快照（旧快照保留在 surface），去重单位是整包 sections。README 与 `docs/DESIGN.md` 已按源码更正。
- **`verify-installed.mjs` 的相对路径解析**：`--plugin` 传相对路径时，相对 cwd 找不到会回退按插件根解析，避免在其它工作目录下误报 FAIL。
- **`node:test` 覆盖补齐**：新增 config 归一化（`null` / 字符串 / 空对象）、section order 断言、同名 section 冲突让出三类用例。

- **Documentation**: the runtime-context snapshot was previously described as a "replace"; the host actually **appends** a new snapshot after comparing the whole section bundle. README and `docs/DESIGN.md` now match the source.
- **`verify-installed.mjs` relative-path handling**: `--plugin` falls back to resolving against the plugin root when the path is not found from the current directory.
- **`node:test` coverage**: added config normalization, section-order assertions, and same-name section conflict cases.

### Verified / 实测（真实数据，不美化）

以下均为 2026-11-19 的快照数据，原文在 `work/lang-rule-tests/out/`（发布仓库不包含该目录，数字可复算）。

1. **headless 3 probe 不足以证明判据成立**：`work/lang-rule-tests/out/live.json`（快照 `2026-11-19T00:09Z`）显示 3 条 probe 中首句英文 **1/3 = 33.3%**，Wilson 95% 区间 **[6.1%, 79.2%]**；区间下界 6.1% 仍高于 5% 阈值，**该轮未通过 <5% 判据**。要检验「首句英文 < 5%」，0 失败至少需要 n≈60；即使 0 失败，n=3 时区间上界也约 63%。
2. **desktop 上 per-request 通道实际生效；此前的「0/6」是检测脚本假阴性**：会话 `03d5a353-2af7-4f71-bdf2-42069a4f0249` 的 `user/message` 事件里，`data.source = {"kind":"runtime-context","form":"snapshot","sections":[…]}`，其中 `sections` 含 `lang-rule:request-tail` 文本（「【本步语言要求】第一句必须是简体中文…」），`surfaceOp = append`；同一会话的 `system/message` 同时含头锚、子智能体锚、mid 与尾锚四段。因此 desktop 上运行的是 **4 section + 1 context**，不是降级。`out/agent-probe-v2.json` 已在 2026-11-19T00:16Z 按正确事件路径重算：10 条 probe 中 **7 条 `containsLangRuleRequestTail: true`**、`runtimeContextEvents` 合计 **16**、0 事件会话 **0**；早先按 `data.message.source` 统计出的 `runtimeContextEvents: 0`（6 条）与 `agent-probe.json`（8 条）是假阴性。检测器已在 2.0.1 修正为兼容 `data.source` 并标注 `via`。
3. **历史语料零回归**：`work/lang-rule-tests/out/corpus.json`（快照 `2026-11-19T00:11Z`）基线 264 个会话、同哈希重算 **261** 个（drift 3，均为活跃会话在基线快照后继续写入）；英文主导会话 **62 → 62**（Δ0），中文主导率 **76.5% → 76.2%**（Δ −0.3pp，阈值 ≤2pp），同哈希会话主导语言全部一致。

- **A 3-probe headless run is not enough to claim the <5% target**: `work/lang-rule-tests/out/live.json` (snapshot `2026-11-19T00:09Z`) shows first-sentence English at **1/3 = 33.3%**, Wilson 95% CI **[6.1%, 79.2%]**; the lower bound (6.1%) is still above the 5% threshold, so **this run did not pass the <5% criterion**. Testing "<5%" with zero failures needs n≈60; even with zero failures the n=3 upper bound is about 63%.
- **The per-request channel does work on desktop; the earlier "0/6" was a detection false negative**: in session `03d5a353-2af7-4f71-bdf2-42069a4f0249`, the `user/message` event carries `data.source = {"kind":"runtime-context","form":"snapshot","sections":[…]}` with a `lang-rule:request-tail` section, and `surfaceOp = append`; the same session's `system/message` contains all four sections. Desktop therefore runs **4 sections + 1 context**, not a degraded mode. `out/agent-probe-v2.json` was recomputed at 2026-11-19T00:16Z through the correct event path: **7 of 10** probes have `containsLangRuleRequestTail: true`, 16 runtime-context events in total, and **0** probes with zero events. The earlier `runtimeContextEvents: 0` values (6 probes, plus 8 in `agent-probe.json`) were false negatives from reading only `data.message.source`; the detector was fixed in 2.0.1 to accept `data.source` and report `via`.
- **No historical-corpus regression**: `work/lang-rule-tests/out/corpus.json` (snapshot `2026-11-19T00:11Z`) — baseline 264 sessions, **261** recomputed with identical hashes (drift 3, all active sessions that kept writing after the baseline snapshot); English-dominated sessions **62 → 62** (Δ0), Chinese-dominated rate **76.5% → 76.2%** (Δ −0.3pp, threshold ≤2pp), and every same-hash session kept its dominant language.

### Known limitations / 已知限制

- **旧宿主无 `systemPrompt.context()` 时降级为 4 个 section**：没有 per-request 尾注，`logger.debug` 记录 `context-api-unavailable`；用 `tools/verify-installed.mjs --strict` 自查。
- **整包 sections 去重**：per-request 快照按整包比较，宿主自身 runtime section 变化时会整包重发，我方尾注随之**重复出现一次**。
- **「禁止英文起手短语」可被绕过**：`work/lang-rule-tests/out/agent-probe-v2.json` 中 session `03d5a353` 的 probe 以 `The task:` 开头（不在禁词表内），该会话首句仍是英文、整段英文（CJK 比 0.028）。禁词表是提示词层的启发式，不是可判定约束。
- **约束强度仍是提示词层**，不能保证每次都输出中文；量化验收以 `tools/lang-audit.mjs --json` 的锚阶段分层为准。
- **v3 方向**：把约束改成可判定形式（例如「首句必须包含中文字符」的硬判据，或利用 prefill 让模型无法以英文起手），而不是继续加长禁词表。

- **Old hosts without `systemPrompt.context()` degrade to four sections**, with no request-tail; `logger.debug` records `context-api-unavailable`. Check with `tools/verify-installed.mjs --strict`.
- **Whole-bundle deduplication**: the per-request snapshot is compared as a whole, so when another runtime section changes the bundle is re-appended and our note **appears once more**.
- **The "no English opener" rule can be bypassed**: in `work/lang-rule-tests/out/agent-probe-v2.json`, the probe for session `03d5a353` started with `The task:` (not on the blocked list); that session was English in both the first sentence and the whole trace (CJK ratio 0.028). The blocked list is a prompt-layer heuristic, not a decidable constraint.
- **The constraint remains prompt-layer only** and cannot guarantee Chinese output every time; quantitative acceptance relies on the anchor-layer breakdown from `tools/lang-audit.mjs --json`.
- **v3 direction**: make the constraint decidable (for example "the first sentence must contain a CJK character", or use prefill so an English opener cannot be produced) instead of extending the blocked-phrase list.

### Compatibility / 兼容性

- **v1 的配置键继续有效**：`text`、`order`、`sectionName`、`tailText`、`tailOrder`、`tailSectionName`、`tailEnabled`。v1 配置原样放入 v2 不会报错，语义不变；新增通道默认开启，可用 `subagentEnabled: false`、`midEnabled: false`、`requestTail: 'off'` 逐条关掉。
- 安装方式的改动手动步骤与 v1 相同：`dsh plugin --profile <your-profile> add github:ArthurZhu1992/dsh-lang-rule`，重启 DSH 生效。
- `engines.node >= 22.15`（审计工具需要 `zlib.zstdDecompressSync`），`engines.dsh >= 0.2.0`。

- **v1 configuration keys keep working**: `text`, `order`, `sectionName`, `tailText`, `tailOrder`, `tailSectionName`, `tailEnabled`. An unchanged v1 config behaves the same in v2; new channels are on by default and can be disabled one by one with `subagentEnabled: false`, `midEnabled: false`, `requestTail: 'off'`.
- Install steps are unchanged from v1: `dsh plugin --profile <your-profile> add github:ArthurZhu1992/dsh-lang-rule`, then restart DSH.
- `engines.node >= 22.15` (the auditor uses `zlib.zstdDecompressSync`), `engines.dsh >= 0.2.0`.

## [1.0.0] — 2026-11-19

### Added

- 头部铁律锚（`lang-rule` @ `-900`）+ 尾部首句锚（`lang-rule:tail` @ `90050`）。
- `tools/lang-audit.mjs` 只读语料审计。
- 中英双语 README、`locale/en.json` 与 `locale/zh.json`、MIT LICENSE、`icon.svg`。

- Head rule anchor (`lang-rule` @ `-900`) and tail first-sentence anchor (`lang-rule:tail` @ `90050`).
- `tools/lang-audit.mjs`, a read-only corpus auditor.
- Bilingual README, `locale/en.json` and `locale/zh.json`, MIT LICENSE, `icon.svg`.
