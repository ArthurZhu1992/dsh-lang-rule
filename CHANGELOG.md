# Changelog

本文件记录 dsh-lang-rule 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
All notable changes to this project are documented here, in the spirit of Keep a Changelog and Semantic Versioning. Each entry is written once in Chinese and once in English.

## [2.0.1] — 2026-11-19

> 定位：**文档与检测工具修正；注入行为与 2.0.0 完全相同**（`index.js` 未改，sha256 `49e8918552a9b8e82270084e5d713eb930f826650a39a8907045052a4f0c1e06`）。

### Fixed / 修复

- **per-request 通道检测假阴性**：`tools/verify-installed.mjs` 旧版只读 `data.message.source`，而 dsh 0.2.2 的 runtime-context 快照落在 `data.source`（`data = { role, content, source }`），已生效的通道因此被误报为 degraded。现统一解包 `data.message` 与 `data` 两种形态，同时接受 `source.kind === 'runtime-context'` 与正文判据词两类证据，并输出 `via=user-system-reminder`；新增纯函数模块 `tools/lib/request-tail-detect.mjs`。
- **撤回 2.0.0 文档里的错误结论**：「desktop 被 `includeRuntimeContext: false` 抑制、0/6 会话无 runtime-context、实际 4 section + mid」是假阴性导致的误判，已改为「desktop 上生效，4 section + 1 context」。
- **数字更正**：headless 首句英文 `2/3` → **1/3 = 33.3%**（Wilson 95% `[6.1%, 79.2%]`，`out/live.json` 快照 `2026-11-19T00:09Z`）；语料重算 `262` → **261**（drift 3）、中文主导 `76.3%` → **76.2%**（`out/corpus.json` 快照 `2026-11-19T00:11Z`）。
- **probe 引用**：`probe-e` 统一改为「会话前缀 `03d5a353` + `out/agent-probe-v2.json`」。

### Changed / 变更

- `tools/selftest.mjs`：28 项 → **32 项**（新增 D 层检测用例：`data.message` 与 `data` 两种形态都能命中、普通 user 消息不误报等）。
- README、RELEASE-NOTES 的 desktop 段落同步改为「生效，不是降级；只有旧宿主无 `systemPrompt.context()` 才降级」。

### Verified / 实测

- `node tools/verify-installed.mjs` → **PASS**；`per-request 约束出现在会话里（3/10 个会话；v2 安装后新会话 8 个）`，`来源 user-system-reminder×3`；样例 `03d5a353 … via=user-system-reminder channel=runtime-context section=lang-rule:request-tail`。
- `out/agent-probe-v2.json`（正确事件路径重算）：10 条 probe、**7 条** `containsLangRuleRequestTail: true`、`runtimeContextEvents` 合计 16。
- `node tools/selftest.mjs` 32/32、`node --test tools/selftest.test.mjs` 8/8。

### Compatibility / 兼容性

- 配置键与注入行为不变；v1 / 2.0.0 的部署无需改动。

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
