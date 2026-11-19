# Versioning / 版本节奏

本仓库从 **1.0.0** 起按本文件发布。1.0.0 是市场首发版本。
This repository releases by this policy starting at **1.0.0**, the first public release.

## 1. SemVer 规则 / Semantic Versioning

版本号 `MAJOR.MINOR.PATCH`，判定标准只跟「对外可观察的行为」有关。

| 位 | 何时 +1 | 例子 |
| --- | --- | --- |
| **MAJOR** | 破坏性变更：已有 config 键失效或被改名；默认行为改变且没有回退开关；注入通道的语义变化（例如某通道不再全局生效） | 删除 `tailText`；默认 `contextVariant` 从 `lazy` 改为 `off` 且无法改回 |
| **MINOR** | 新增通道、档位、能力，且旧配置继续有效 | 新增第四条 section；新增 `preset` 档；新增 `measure-*` 工具与对应指标 |
| **PATCH** | 修复、文档、工具行为修正；不改变默认文本与默认开关 | 修 `verify-installed` 的假阴性；改 README 数字；修 `measure-appends` 的计数 |

- **一次发布只升一个语义位**；同一版本内不混入下一次 MAJOR 的破坏性准备。
- 判据文本（「第一句必须包含中文字符、不得以 ASCII 字母开头」）与五通道 order（`-900` / `-880` / `5100` / `90050` / `500`）视为**对外契约**：改动它们至少是 MINOR；删除或改变语义是 MAJOR。
- 三档 preset 的 token 预算（125 / 181 / 337）同样视为契约；超预算的改动需要 MINOR 并在 CHANGELOG 说明。

- One semantic level per release. The rule text and the five channel orders are part of the public contract: changing them is at least MINOR, removing or redefining them is MAJOR. Preset budgets are contracts too.

## 2. 发布节奏 / Release cadence

- **用 `Unreleased` 累积**：CHANGELOG 顶部维护 `## [Unreleased]`，所有改动先进这里。
- **一个迭代一次发布**：一轮完整工作（实现 → 测试 → 审查）结束后只发一个版本，不按单个 finding、单次审查意见发版。
- **不按单个 finding 发版**：审查发现的 low / 文档问题，合并进下一个迭代的 Unreleased，随该迭代一起发。
- **紧急修复才用 PATCH**：仅当线上可用性/正确性受损时才单独发 patch，且必须 CI 全绿（`verify.yml` 与 `publish.yml` 都通过）。
- 每次发布必须同时满足：`package.json` version、CHANGELOG 首段版本、`v<version>` tag、tag commit == `main`，由 `publish.yml` 自动校验。

- Accumulate under `Unreleased`; one release per iteration; never release per single review finding; PATCH only for urgent fixes, and only with all CI green. Every release must satisfy version == CHANGELOG first section == `v<version>` tag, with the tag commit equal to `main` (enforced by `publish.yml`).

## 3. 预发布 / Pre-releases

- 试验性机制用 `-rc.N`（如 `1.1.0-rc.1`），**不占正式版本号**，不更新「latest」Release。
- 预发布的 config 键可以在正式版前改名；一旦进入正式版，按第 4 节的兼容承诺处理。
- 预发布同样需要 CI 全绿；不因为「反正是 rc」跳过门禁。

- Experimental mechanisms use `-rc.N`; pre-releases never take a stable version number and are not marked "latest". Config keys may still change before the stable release.

## 4. 兼容承诺 / Compatibility promise

- **config 键至少保留一个 MINOR 周期**：标记弃用后，下一个 MINOR 仍接受该键（可为 no-op），再下一个 MAJOR 才移除。
- **弃用先在 CHANGELOG 标注**：在 `Deprecated` 小节写清键名、替代键、计划移除版本。
- 默认值改变必须提供回退开关（如 `contextVariant: 'off'`）；没有回退开关的默认改变视为 MAJOR。
- 旧配置「能加载、不报错、行为可预期」是底线；无法保证时按 MAJOR 处理。

- Deprecated config keys survive at least one MINOR cycle and are announced under `Deprecated` first. Any default change ships with an opt-out switch, otherwise it is MAJOR.

## 5. 本仓库历史说明 / Repository history

- 开发期（2026-11-19 当天）曾快速迭代并打过 6 个快照 tag：`v1.0.0`、`v2.0.0`、`v2.0.1`、`v3.1.0`、`v3.1.2`、`v3.1.3`。这些版本**从未对外发布**（无 npm 包、未上市场、无下载）。
- 为让市场首发版本号干净，这 6 个 tag 与对应 GitHub Release **已删除归档**；对应 commit **仍在 git 历史中**，可按 commit 找回，但不再作为版本引用。
- **1.0.0 是市场首发版本**，其内容 = 开发期 3.1.3 的全部能力（五通道、可判定判据、few-shot、三态变体、三档 preset、工具链、CI）+ 版本号重置。
- CHANGELOG 以附录形式保留开发期记录，只是历史留存，**不构成版本号**。

- Six development snapshot tags were created on 2026-11-19 and never published. Their tags and Releases were removed so that the first public version number is clean; the commits remain in git history. **1.0.0 is the first public release** and equals the full development capability set, with only the version number reset.

## 6. 发布检查清单 / Release checklist

1. `Unreleased` 内容归类到目标版本，更新 CHANGELOG 首段。
2. `package.json` version 与 CHANGELOG 首段一致。
3. `node --check`、selftest、node:test、verify-installed、measure-appends `--dry-run`、measure-tool-variant `--simulate` 全绿。
4. push `main`，打 annotated tag `v<version>` 并 push。
5. `publish.yml` 四道校验通过（版本、CHANGELOG、tag commit、tag 树）。
6. 建 GitHub Release（非 draft），正文与 CHANGELOG 同口径。
7. 不改历史 tag、不 force push、不 rebase 已发布 commit。

- Classify `Unreleased`, align version and CHANGELOG, run the full gate, tag, let `publish.yml` verify, publish a non-draft Release, and never rewrite published tags or history.
