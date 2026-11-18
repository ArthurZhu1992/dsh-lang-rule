# Release Notes — dsh-lang-rule

> 说明：`v1.0.0` tag 打在初始提交 `f1e0acf`，本文件随后以 `da80bb9` 加入 `main`，因此 tag 树不含本文件，不是漏提交。后续 `v2.0.0` 会把 tag 打在包含本文件的最终提交上。

## 仓库

<https://github.com/ArthurZhu1992/dsh-lang-rule>（public，默认分支 `main`）

## 当前版本

| 项 | 值 |
| --- | --- |
| 版本 | `1.0.0` |
| Tag | `v1.0.0` |
| 发布形态 | 可直接 `dsh plugin add` 的 bundle（自带 `cordis.patch.yml`） |
| 许可 | MIT © 2026 ArthurZhu1992 |

### 安装

```bash
dsh plugin --profile <your-profile> add github:ArthurZhu1992/dsh-lang-rule
```

重启 DSH 后生效。等价写法（任意 git 远端）：

```bash
dsh plugin --profile <your-profile> add git+https://github.com/ArthurZhu1992/dsh-lang-rule.git
```

卸载：

```bash
dsh plugin --profile <your-profile> remove dsh-lang-rule
```

### 本版内容

- `index.js`：头部锚 order `-900`（长版中文铁律）+ 尾部锚 order `90050`（一行「第一句必须中文」），通过 `ctx.systemPrompt.section()` 注入；服务缺失或同名被占用时静默降级。
- `cordis.patch.yml`：作为 bundle 自动插入 `dsh-lang-rule`，无需手改宿主补丁。
- `tools/lang-audit.mjs`：只读审计工具，统计会话 reasoning 中文占比、首句语言、铁律/尾锚是否进入 system message。会话目录默认 `~/.dsh/sessions`，可用 `DSH_SESSIONS_ROOT` 覆盖。需 Node ≥22.15（`zlib.zstdDecompressSync`）；插件本体不依赖该版本。
- `locale/zh.json`、`locale/en.json`：`meta.title` / `meta.description`（作用、覆盖范围、验证方法、关掉后的影响）。
- `README.md`：中英双语安装/验证/配置/卸载说明。
- `icon.svg`：纯几何 path 图标，无 text/font。
- `LICENSE`：MIT。
- `package.json`：无 `private`，含 `repository` / `homepage` / `bugs` / `keywords` / `engines.node` / `engines.dsh`。

### 发布验证记录

| 检查 | 结果 |
| --- | --- |
| `gh repo view ArthurZhu1992/dsh-lang-rule --json name,visibility,defaultBranchRef,url` | `visibility=PUBLIC`，`defaultBranchRef=main` |
| `git ls-remote --tags origin v1.0.0` | `refs/tags/v1.0.0` 可见 |
| `gh api repos/ArthurZhu1992/dsh-lang-rule/contents/package.json` | `HTTP/2.0 200 OK` |
| 新目录 `git clone --depth 1` + `node --check index.js` | 通过；`tools/lang-audit.mjs` 同样通过 |
| 隔离目录 `pnpm add github:ArthurZhu1992/dsh-lang-rule` | 解析并安装 `dsh-lang-rule 1.0.0`，落地 `index.js`、`tools/`、`locale/`、`cordis.patch.yml`、`README.md`、`LICENSE`、`icon.svg` |

## v2 待办

1. 等 v2 审查（t4）通过后，在 `2.0.0` 中加入第三处锚点与语料审计结论，并把进化测试 harness 一并发布。
2. 升 `package.json` 到 `2.0.0`，打 `v2.0.0` tag；`v1.0.0` 标签保留可回溯。
3. 更新 README 的「当前状态」段落与 locale 文案（补 v2 的量化验证结论）。
4. 市场侧（dsh-market / awesome-dsh-plugin）提交暂缓，等 v2 落地后再做，避免把 v1 基线写进市场数据源。
