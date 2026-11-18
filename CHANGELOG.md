# Changelog

本文件记录 dsh-lang-rule 的重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
All notable changes to this project are documented here, in the spirit of Keep a Changelog and Semantic Versioning. Each entry is written once in Chinese and once in English.

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

以下均为 2026-11-18 在本机实测结果，原文数据在 `work/lang-rule-tests/out/`（发布仓库不包含该目录，数字可复算）。

1. **headless 3 probe 不足以证明判据成立**：3 条 probe 中首句英文 **2/3 = 66.7%**，Wilson 95% 区间 **[20.8%, 93.9%]**。要检验「首句英文 < 5%」，0 失败至少需要 n≈60；n=3 时区间上界约 63%。**该轮未通过 <5% 判据**。
2. **desktop profile 上 per-request 通道被抑制**：`dsh-norefuse` 的 `includeRuntimeContext: false` 让上下文快照整体关闭。v2 生效期的 6 条 probe 会话 **0/6 有 runtime-context 事件**（另有 v1 生效期 8 条对照同样为 0）。实际生效的是 4 个 section + mid，没有 request-tail；插件按设计进入 degraded 模式，不报错。
3. **历史语料零回归**：基线 264 个会话、同哈希重算 262 个；英文主导会话 **62 → 62**（Δ0），中文主导率 **76.5% → 76.3%**（Δ −0.2pp，阈值 ≤2pp），同哈希会话主导语言全部一致。

- **A 3-probe headless run is not enough to claim the <5% target**: first-sentence English was **2/3 = 66.7%**, Wilson 95% CI **[20.8%, 93.9%]**. Testing "<5% first-sentence English" with zero failures needs n≈60; at n=3 the upper bound is about 63%. **This run did not pass the <5% criterion.**
- **The per-request channel is suppressed on the desktop profile**: `dsh-norefuse` sets `includeRuntimeContext: false`, turning runtime-context snapshots off. In the v2 window, **0 of 6** probe sessions had runtime-context events (a v1-window batch of 8 was also 0). What actually runs is four sections plus mid; there is no request-tail, and the plugin degrades without errors.
- **No historical-corpus regression**: baseline 264 sessions, 262 recomputed with identical hashes; English-dominated sessions **62 → 62** (Δ0), Chinese-dominated rate **76.5% → 76.3%** (Δ −0.2pp, threshold ≤2pp), and every same-hash session kept its dominant language.

### Known limitations / 已知限制

- **旧宿主无 `systemPrompt.context()` 时降级为 4 个 section**：没有 per-request 尾注，`logger.debug` 记录 `context-api-unavailable`；用 `tools/verify-installed.mjs --strict` 自查。
- **整包 sections 去重**：per-request 快照按整包比较，宿主自身 runtime section 变化时会整包重发，我方尾注随之**重复出现一次**。
- **「禁止英文起手短语」可被绕过**：probe-e 的 prompt 以 `The task:` 开头（不在禁词表内），该会话首句仍是英文、整段英文（CJK 比 0.028）。禁词表是提示词层的启发式，不是可判定约束。
- **约束强度仍是提示词层**，不能保证每次都输出中文；量化验收以 `tools/lang-audit.mjs --json` 的锚阶段分层为准。
- **v3 方向**：把约束改成可判定形式（例如「首句必须包含中文字符」的硬判据，或利用 prefill 让模型无法以英文起手），而不是继续加长禁词表。

- **Old hosts without `systemPrompt.context()` degrade to four sections**, with no request-tail; `logger.debug` records `context-api-unavailable`. Check with `tools/verify-installed.mjs --strict`.
- **Whole-bundle deduplication**: the per-request snapshot is compared as a whole, so when another runtime section changes the bundle is re-appended and our note **appears once more**.
- **The "no English opener" rule can be bypassed**: probe-e's prompt started with `The task:` (not on the blocked list), and that session was English in both the first sentence and the whole trace (CJK ratio 0.028). The blocked list is a prompt-layer heuristic, not a decidable constraint.
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
