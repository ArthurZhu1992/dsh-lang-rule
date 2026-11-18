# dsh-lang-rule

**部署级语言策略：连子智能体的思考（reasoning）也要求中文。**

**Deployment-level language policy: even a subagent's reasoning must be Chinese.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-1f6feb)](https://github.com/ArthurZhu1992/dsh-lang-rule)

---

## 中文

### 这是什么

`dsh-lang-rule` 是一个只做提示词层的 DSH 插件：它通过 `ctx.systemPrompt.section()` 向系统提示词注册表注入中文铁律，要求**内部推理（thinking / reasoning）与可见回复一律使用简体中文**。代码、命令、路径、API 名、报错原文保持英文，唯一例外是用户明确要求改用其他语言。

它不只约束主 agent。section 是全局作用域的，因此**子智能体、AgentTeams 成员、Agency expert、后台任务，以及它们产出的计划、摘要、评审结论、错误说明**，拿到的是同一段约束。

### 为什么需要两个锚点

reasoning 每个 step 独立采样：首句语言一旦是英文，后续自回归几乎全程英文；首句是中文则绝大多数段落保持中文。所以：

- **头部锚**（order `-900`）：长版铁律，紧跟 harness 身份段（`-1000`），负责“定性”。它离采样点隔着十几 KB 英文工具 schema，约束力会被摊薄。
- **尾部锚**（order `90050`）：一行短提醒，排在所有宿主 section 之后，recency 最强，负责“逼第一句”。

两者都失败时插件静默退出，不阻断 DSH 启动。

### 当前状态

- **v1.0.0（tag `v1.0.0`，当前基线）**：头部锚 + 尾部锚双锚注入，含只读审计工具 `tools/lang-audit.mjs`。
- **v2 三锚版随后推送（计划升 `2.0.0`）**：第三处锚点 + 语料审计结论 + 进化测试 harness。等 v2 审查通过后在本仓库推 `v2.0.0` tag，v1 标签保留可回溯。

### 安装

```bash
dsh plugin --profile <your-profile> add github:ArthurZhu1992/dsh-lang-rule
```

`<your-profile>` 换成你的 profile 名，例如 `desktop`（桌面端默认）或 `web`。

从本地目录安装（等价，便于调试）：

```bash
git clone https://github.com/ArthurZhu1992/dsh-lang-rule
dsh plugin --profile <your-profile> add file:/absolute/path/to/dsh-lang-rule
```

安装后**重启 DSH**（或重新加载 profile）。插件自带 `cordis.patch.yml`，会作为 bundle 自动插入 `dsh-lang-rule` 条目，无需手改宿主补丁。

### 验证是否生效

1. **日志**：启动后在日志里找 `[lang-rule] 已注册系统提示 section`，`registered` 应含 `lang-rule` 与 `lang-rule:tail`。
2. **审计工具**（只读会话文件，不发消息）：

   ```bash
   node tools/lang-audit.mjs            # 最近 40 个会话
   node tools/lang-audit.mjs <session>  # 指定会话及其子会话
   ```

   输出每会话的中文占比、首句语言、是否含铁律/尾锚。会话目录默认 `~/.dsh/sessions`，可用 `DSH_SESSIONS_ROOT` 覆盖。

   **Node 版本**：审计工具用 `zlib.zstdDecompressSync` 解压会话文件，需要 **Node ≥ 22.15**；插件本体（`index.js`）只使用 `ctx.systemPrompt.section()` 与 `ctx.logger`，不依赖该版本。
3. **手动**：新开一个会话，随便问一句需要思考的问题，观察 reasoning 第一句是否是中文；再让一个子智能体跑任务，看它的产出语言。

### 配置

在 profile 的 `cordis.patch.yml` 中给条目加 `config` 即可覆盖默认值：

```yaml
- insert:
    - id: dsh-lang-rule
      name: dsh-lang-rule
      config:
        text: "……头部铁律正文……"     # 替换默认头部锚
        order: -900                    # 头部锚排序
        tailText: "……尾部提醒……"      # 置空字符串则关闭尾部锚
        tailOrder: 90050
        tailEnabled: true              # false 等价于关闭尾部锚
```

所有字段都有安全默认值；同名 section 已被占用时插件让出，不抛错。

### 卸载

```bash
dsh plugin --profile <your-profile> remove dsh-lang-rule
```

然后确认 profile 的 `package.json` 里 `dsh.profile.bundles` 不再包含 `dsh-lang-rule`（插件管理器通常会自动处理），重启 DSH。卸载后英文 thinking 会恢复。

### 兼容性与边界

- 只依赖 `ctx.systemPrompt.section()` 与 `ctx.logger`，不 import 任何 cordis / DSH 内部模块。
- `systemPrompt` 服务缺失或 `section()` 签名变化时静默退出。
- 无 UI、无网络、无文件写入（审计工具只读）。
- `engines.dsh` 标记为 `>=0.2.0`；更老的 DSH 缺少 `systemPrompt.section`，插件会安静地不生效。
- `engines.node` 标记为 `>=22.15`，由随包的 `tools/lang-audit.mjs` 决定；插件本体不依赖这个版本。

### 许可证

MIT © 2026 ArthurZhu1992

---

## English

### What it is

`dsh-lang-rule` is a prompt-layer-only DSH plugin. It registers sections through `ctx.systemPrompt.section()` and requires **all internal reasoning (thinking) and all visible output to be Simplified Chinese**. Code, commands, paths, API names and raw error text stay in English; the only exception is an explicit user request for another language.

The section is global, so the same rule reaches **subagents, AgentTeams members, Agency experts, background jobs, and everything they produce** (plans, summaries, review verdicts, error explanations).

### Why two anchors

Reasoning is sampled per step: once the first sentence is English, the rest of the trace stays English; a Chinese first sentence keeps most paragraphs Chinese. So:

- **Head anchor** (order `-900`): the full rule, right after the harness identity section (`-1000`). It sets the policy but sits more than ten KB of English tool schemas away from the sampling point.
- **Tail anchor** (order `90050`): one short reminder after every host section, with the strongest recency, forcing the first sentence.

If either registration fails, the plugin silently degrades instead of blocking DSH startup.

### Status

- **v1.0.0 (tag `v1.0.0`, current baseline)**: head + tail anchors, plus the read-only auditor `tools/lang-audit.mjs`.
- **v2 (planned `2.0.0`)**: a third anchor, corpus-audit findings and an evolution test harness, pushed after v2 review. The `v1.0.0` tag stays for traceability.

### Install

```bash
dsh plugin --profile <your-profile> add github:ArthurZhu1992/dsh-lang-rule
```

`<your-profile>` is your profile name, e.g. `desktop` (the desktop default) or `web`.

Local checkout (identical, easier to debug):

```bash
git clone https://github.com/ArthurZhu1992/dsh-lang-rule
dsh plugin --profile <your-profile> add file:/absolute/path/to/dsh-lang-rule
```

Restart DSH (or reload the profile) afterwards. The package ships its own `cordis.patch.yml`, so it is inserted as a bundle automatically; no manual host patch editing.

### Verify

1. **Log**: after startup look for `[lang-rule] 已注册系统提示 section`; `registered` should list `lang-rule` and `lang-rule:tail`.
2. **Auditor** (read-only, sends nothing):

   ```bash
   node tools/lang-audit.mjs            # last 40 sessions
   node tools/lang-audit.mjs <session>  # one session and its children
   ```

   It reports Chinese ratio, first-sentence language, and whether the rule/tail anchor reached the system message. Sessions default to `~/.dsh/sessions`; override with `DSH_SESSIONS_ROOT`.

   **Node version**: the auditor decompresses session files with `zlib.zstdDecompressSync`, which requires **Node ≥ 22.15**; the plugin itself (`index.js`) only uses `ctx.systemPrompt.section()` and `ctx.logger` and does not depend on it.
3. **Manual**: start a session with a prompt that requires thinking and check whether the first reasoning sentence is Chinese; then run a subagent task and check its output language.

### Configure

Add `config` to the plugin entry in the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-lang-rule
      name: dsh-lang-rule
      config:
        text: "…head rule…"          # replaces the default head anchor
        order: -900
        tailText: "…tail hint…"      # empty string disables the tail anchor
        tailOrder: 90050
        tailEnabled: true
```

Every field has a safe default; if a section name is already taken the plugin yields instead of throwing.

### Uninstall

```bash
dsh plugin --profile <your-profile> remove dsh-lang-rule
```

Check that `dsh.profile.bundles` in the profile `package.json` no longer lists `dsh-lang-rule` (the plugin manager normally handles it), then restart. English thinking returns.

### Compatibility

- Uses only `ctx.systemPrompt.section()` and `ctx.logger`; imports no cordis or DSH internals.
- Silently exits when the `systemPrompt` service is missing or `section()` changes shape.
- No UI, no network, no file writes (the auditor is read-only).
- `engines.dsh` is `>=0.2.0`; older DSH builds without `systemPrompt.section` simply get no effect.
- `engines.node` is `>=22.15`, driven by the bundled `tools/lang-audit.mjs`; the plugin itself does not depend on that version.

### License

MIT © 2026 ArthurZhu1992
