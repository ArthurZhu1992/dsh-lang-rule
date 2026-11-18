# V2 发布清单 — 来自 t7 独立审查的 5 条低危项

> 来源：gate-reviewer 的 t7 审查（verdict = pass，v1.0.0 发布面可用）。
> 结论：**v1.0.0 不回滚、不移动 tag**。第 2、3 条已按 captain 要求在 t11 提前修复并推送；剩余 1、4 条留到 v2。

## 1. tag 与 main 的提交对齐

- **问题**：`v1.0.0` 指向 `f1e0acf`，`main` 是 `da80bb9`；tag 树不含 `RELEASE-NOTES.md`。
- **v2 修法**：打 `v2.0.0` 前先确认 `git status --short` 为空（只允许有意保留的无关本地文件），tag 打在**最终发布提交**上；推送后用 `git ls-remote --tags origin v2.0.0` 与 `git rev-list -n1 v2.0.0` 双向核对。
- **约束**：`v1.0.0` 保持不动（移动 tag 需要 force push，禁止）。
- **状态**：待 v2 执行。

## 2. `engines.node` 与审计工具的真实要求

- **问题**：`package.json` 写 `engines.node: ">=18"`，但 `tools/lang-audit.mjs` 调用 `zlib.zstdDecompressSync`（Node ≥ 22.15）。插件主体 `index.js` 在 Node 18 上可运行，审计脚本不行。
- **v2 修法（二选一）**：
  - 把 `engines.node` 提到 `>=22`（整包口径，最省心）；或
  - 保留 `>=18`，在 README 与 `locale/*.json` 的验证说明里写明「审计工具需 Node 22+（zstd 解压）」。
- **附带**：README 的两处审计命令旁同步加注。
- **状态**：**已修（t11）**——`engines.node` 改为 `>=22.15`；README 中英「验证」章节与「兼容性与边界」各加一句：审计工具需 Node ≥22.15，插件本体不依赖该版本；两处口径一致。

## 3. README 安装命令写死 profile 名

- **问题**：README（中英两份）都写 `dsh plugin --profile desktop add …`，读者若用 `web` 等其它 profile 需自行改。
- **v2 修法**：改为 `dsh plugin --profile <profile> add github:ArthurZhu1992/dsh-lang-rule`，并加一句「`<profile>` 换成你的 profile 名（如 `desktop` / `web`）」，与 dshmarket 官方 README 口径一致。`RELEASE-NOTES.md` 与 `MARKET-PR-DRAFT.md` 里的示例同步改成占位符形式。
- **状态**：**已修（t11）README 中英两份**——安装/本地安装/卸载命令全部改为 `--profile <profile>`，并保留 `desktop` / `web` 示例句；`RELEASE-NOTES.md`、`MARKET-PR-DRAFT.md` 的示例留到 v2/市场提交前同步（不属于本次 README 范围）。

## 4. 市场文案口径：只写已发布事实

- **问题**：仓库当前只有 v1 双锚 + `tools/lang-audit.mjs`；没有 `selftest.mjs`、没有 `v2.0.0` tag。
- **修法**：t8 提交 `awesome-dsh-plugin` 前，条目描述只能是「两段 system prompt + 只读审计脚本」，**不得**出现 v2 三锚 / 进化测试 harness / 任何未发布的机理或数字；v2 落地并打 tag 后再另发 2.0.0 并更新条目。
- **现状**：`MARKET-PR-DRAFT.md` 第 2 节描述已符合该口径（two sections + read-only audit script），t8 时的收尾动作 = 复核一遍再提交。
- **状态**：已按口径写好草稿，提交前再复核。

## 5. `RELEASE-NOTES.md` 补 tag 树说明

- **问题**：第三方核对 tag 树时会发现 `RELEASE-NOTES.md` 不在 `v1.0.0` 里，容易误判为漏提交。
- **修法**：在 `RELEASE-NOTES.md` 顶部加一句：「`v1.0.0` tag 打在初始提交 `f1e0acf`，本文件随后以 `da80bb9` 加入 `main`，因此 tag 树不含本文件。」
- **状态**：**已在本次提交中补上**（纯文档说明，不改 tag、不改代码）。

---

## v2 发布门

1. t4（v2 审查）通过后才动 v2 发布；t4 未通过前不开闸。
2. 发布顺序：改 `package.json` → 2.0.0 → 更新 README/locale → 跑基线验证（clone + `node --check` + 隔离 `pnpm add`）→ commit → tag `v2.0.0` → push tag → 建 GitHub Release → 回写 `RELEASE-NOTES.md`。
3. 全程不 force push、不移动 `v1.0.0`。
