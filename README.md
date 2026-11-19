# dsh-lang-rule v2

部署级语言策略插件：让 **每一个** dsh agent ——主 agent、subagent、AgentTeams 成员、workflow 子智能体、后台任务——的推理（thinking / reasoning）与可见输出全程简体中文。

> v2 的核心变化：**不再只加长尾锚**。新增一条 per-request 通道，把「本步第一句必须中文」的约束推到模型采样点前最后一段文本；因为实测数据显示，决定整段语言的是**首句**，而不是锚文本有多长。

- 版本：`2.0.1`（v1 为 `1.0.0`，配置向后兼容；2.0.1 只改文档与检测工具，注入行为同 2.0.0）
- 运行要求：dsh ≥ 0.2.0；不 import 任何 dsh/cordis 内部模块，服务缺失即静默降级
- 零网络、零写入：插件只注册提示词贡献，工具只读会话文件
- 部署注意：desktop profile 上 per-request 通道**生效**，以宿主生成的 user 角色 `<system-reminder>` 快照注入（`event.data.source.kind = "runtime-context"`，`surfaceOp = "append"`，`sections` 含 `lang-rule:request-tail`）；降级只发生在宿主没有 `systemPrompt.context()` 的旧版本，用 `tools/verify-installed.mjs --strict` 自查（输出 `via=user-system-reminder` 即生效）

---

## 为什么首句比长度更重要（实测依据）

对 `~/.dsh/sessions` 下全部 280 个会话目录（264 个含 reasoning）做了全量审计，结论：

| 锚阶段 | 会话数 | 英文主导率 | 首句英文率 |
| --- | --- | --- | --- |
| 无任何锚 | 12 | **75.0%** | 58.3% |
| 仅头部锚 | 73 | **39.7%** | 39.7% |
| 头部锚 + 尾部锚（v1） | 179 | **13.4%** | 21.2% |

- **首句是唯一强预测因子**：首句英文 → 整段英文主导 **81.1%（60/74）**；首句中文 → 整段英文主导 **1.1%（2/190）**。
- v1 的 head+tail 已经吃掉大半收益（39.7% → 13.4%），再加长尾锚文本边际收益极低。
- 剩余 24 个英文会话全部首句英文，且**头尾锚齐全、尾锚 100% 可见、距 system 末尾仅 75 字符**。真正原因是 system 之后还插着 **15,621–16,704 字符** user 文本（AgentTeams 英文分派模板 + 三条 system-reminder，中位 15,919）：尾锚在 system「内部」最后，却不在请求「整体」最后。
- 子会话是重灾区：首句英文率 **32.5%**（68/209），主会话仅 **10.9%**。

所以 v2 的设计目标只有一句：**让采样点前最后一段文本是中文首句约束，并让它覆盖子会话。**

完整审计报告与复现脚本见仓库发布的 `LANG-AUDIT.md`（由 `tools/lang-audit.mjs` 生成 JSON）。

---

## 五通道设计（v2）

| # | 通道 | order | 位置 | 作用 | 默认文本长度 |
| --- | --- | --- | --- | --- | --- |
| 1 | `section` `lang-rule` | **-900** | harness 身份段（-1000）之后、部署 persona（0）之前 | 长版铁律：定性「全程中文、不得用英文思考」 | ≈165 字符 |
| 2 | `section` `lang-rule:subagent` | **-880** | 紧跟头锚 | 显式点名 subagent / AgentTeams 成员 / workflow 子智能体 / 后台任务 | ≈53 字符 |
| 3 | `section` `lang-rule:mid` | **5100** | 工具 schema（TOOLS_SDK=5000）之后、结构化输出（9900）之前 | 工具文档后再重申一次首句约束 | ≈90 字符 |
| 4 | `section` `lang-rule:tail` | **90050** | 全部宿主 section 之后 | 尾部首句锚：第一句必须中文 + 禁词表 + 英文提示不豁免 | ≈74 字符 |
| 5 | `context` `lang-rule:request-tail` | **500** | 宿主 context 上界（WEB_SURFACE=210）之后；每个 step 由宿主把 runtime-context 快照 append 在 claimed 消息之后 | **per-request 通道**：每请求重新渲染；模型看到的是宿主生成的 user 角色 `<system-reminder>` 快照，位于本 step 最后 | ≈76 字符 |

**作用域说明**：五个通道都是全局 `section` / `context` 注册，对**所有** agent（主 agent、subagent、AgentTeams 成员、workflow 子智能体、后台任务）可见。子智能体锚里的「点名」是提示词层面的强化（让模型知道这条对子角色同样强制），不是作用域过滤——不存在「只对子 agent 生效」的分支。

### order 是怎么算出来的（非猜测）

读宿主 `@deepseek-ai/dsh-system-prompt` 源码（dsh 0.2.2-rc.3，`src/index.ts`）：

```ts
const SECTION_ORDERS = { HARNESS_IDENTITY: -1000, … , DELIVERABLE_FILE_REFERENCES: 9000,
  STRUCTURED_OUTPUT: 9900, HARNESS_SOURCE: 10000, WEB_SURFACE: 10100, DEPLOYMENT_PERSONA_SUFFIX: 10200 }
const CONTEXT_ORDERS = { WORKING_DIRECTORY: 100, SANDBOX_POLICY: 110, APPROVAL_POLICY: 115,
  SUBAGENT_DELEGATION: 120, HARNESS_SOURCE: 200, WEB_SURFACE: 210 }
```

- 宿主 **section** 上界 = `DEPLOYMENT_PERSONA_SUFFIX` = **10200** → 尾锚默认 `max(90050, 上界 + 1000)`，恒在最后；
- 宿主 **context** 上界 = `WEB_SURFACE` = **210** → per-request 通道默认 `max(500, 上界 + 100)`；
- 运行时用 `registry.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')` / `registry.getContextOrder('WEB_SURFACE')` **探测**这两个上界（服务方法不存在或抛错则回退到上面常量）。因此 order 可解释、可覆盖、随宿主演进自适应——宿主未来把上界提到 20000，尾锚会自动排到 ≥21000。

### per-request 通道为什么是 `systemPrompt.context()` 而不是塞 user 消息

宿主 `@deepseek-ai/dsh-agent-loop` 的每步流程是：`preStep()` → `systemPrompt.assemble()` → 把 runtime-context 快照追加在 claimed 消息**之后**（`[...claimed, context]`），再 `buildRequest()`。该快照：

- 每请求重新渲染（是真正的 per-request 面）；
- 物化形态是**宿主生成的 user 角色消息**：`createUserMessage({ source: { kind: 'runtime-context', form: 'snapshot' } })`，内容用 `<system-reminder>` 包裹。它**不修改、不拼接真实用户消息内容**，而是宿主自己的上下文快照通道；
- 文本固定 → 宿主 `RuntimeContextProjection.project()` 用 `deepEqualJson(previous, sections)` 判重（去重单位是**整包 sections**）：整包不变才跳过 append。若宿主自身的 runtime section 某步变化（时间、cwd 等），整包会重新 append，我方尾注会随整包一起重复出现一次——这是「不重复」成立的前提，写在这里以免误读；
- 变化时 **append 新快照，旧快照保留在 surface**（`agent.ts` 里是 `session.append('user/message', context, { surfaceOp: 'append' })`，没有 replace；`deriveMessages()` 全量派生）。固定文本只在首次 append，不会每步重复；
- 注册为 `required: true`：宿主 `assemble()` 的 suppress 过滤是 `filter(entry => !runtimeContextSuppressed || entry.required === true)`（`dsh-system-prompt/src/index.ts`），`refreshContext()` 同样对 required 放行，因此部署关闭可选 runtime context 时该条仍保留。

这是宿主官方机制，不伪造用户输入、不改写用户消息内容。

---

## 配置

全部为可选键，默认值即推荐值。**v1 的 `text` / `order` / `sectionName` / `tailText` / `tailOrder` / `tailSectionName` / `tailEnabled` 继续有效。**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时不注册任何通道（基线对照） |
| `headEnabled` | `true` | 头锚开关 |
| `headText` | 内置铁律 | 头锚正文（别名 `text`，v1 兼容） |
| `headOrder` | `-900` | 头锚 order（别名 `order`，v1 兼容） |
| `sectionName` | `lang-rule` | 头锚 section 名 |
| `subagentEnabled` | `true` | 子智能体锚开关 |
| `subagentText` | 内置 | 子智能体锚正文 |
| `subagentOrder` | `-880` | 子智能体锚 order |
| `subagentSectionName` | `lang-rule:subagent` | 子智能体锚 section 名 |
| `midEnabled` | `true` | 工具文档后重申开关 |
| `midText` / `midOrder` / `midSectionName` | 内置 / `5100` / `lang-rule:mid` | mid 锚 |
| `tailEnabled` | `true` | 尾部首句锚开关 |
| `tailText` | 候选 A 版 | 尾部锚正文（v1 兼容） |
| `tailOrder` | `max(90050, 宿主上界+1000)` | 尾部锚 order（v1 兼容） |
| `tailSectionName` | `lang-rule:tail` | 尾部锚 section 名（v1 兼容） |
| `requestTail` | `'context'` | per-request 通道：`'context'` 启用；**`'off'` 或 `false` 完全回到 v1 纯 section 行为**（回归对比用） |
| `requestEnabled` | `true` | 与 `requestTail` 等价的布尔开关 |
| `requestText` | 内置 | per-request 约束正文 |
| `requestOrder` | `max(500, 宿主 context 上界+100)` | per-request context order |
| `requestSectionName` | `lang-rule:request-tail` | per-request context 名 |

示例（profile 的 cordis 配置）：

```yaml
- id: dsh-lang-rule
  name: dsh-lang-rule
  config:
    requestTail: context      # off = 回到 v1 行为
    tailOrder: 90050
```

---

## 尾部锚候选文本

`index.js` 导出 `TAIL_CANDIDATES`（A / B / C 三版）。默认 **A 版**，因为它最短、判据最稳、token 最省：

```
【本步语言要求】第一句必须简体中文；不得以 Let me / Let's / I'll / We need to 起手；任务提示是英文也不豁免。
```

判据口径与 harness 一致：**「第一句」而非「第一个字符」**——reasoning 首字符经常是 `**`、反引号、数字或空格，按字符判定会假阴性。harness 判定方法：去掉行首 Markdown 定界符与空白 → 取首句 → CJK ≥ 1 且 CJK > 拉丁字母 × 0.5，且不以英文祈使句开头。

`selftest.mjs` 断言：默认文本 = A 版、三版都存在、每版都含 `Let me` 与 `第一句`、且不含「第一个字符」与条件从句。

---

## 降级与抗升级

| 情况 | 行为 |
| --- | --- |
| `ctx.systemPrompt` 缺失 / `section()` 不是函数 | 直接返回，不抛异常，不阻断 dsh 启动 |
| 某条 `section()` 抛错（同名被占用等） | 只跳过该条，继续注册其余通道；`logger.debug` 记录，不打扰用户 |
| `systemPrompt.context()` 不存在（旧宿主） | **degraded**：只保留 4 个 section，`logger.debug` 标注 `context-api-unavailable` |
| `logger` 缺失或 `logger.info/debug` 抛错 | 吞掉，注册照常 |
| 部署调用 `suppressRuntimeContext()` | per-request 通道注册为 `required:true`，仍生效 |
| 宿主 order 上界变化 | 运行时探测 `getSectionOrder` / `getContextOrder` 自动适配 |

注册成功时 `logger.info` 打印形如：

```
[lang-rule] v2 已注册语言约束 { channels: ['section:lang-rule@-900', …, 'context:lang-rule:request-tail@500'], requestTail: 'context', degraded: false }
```

### degraded 模式（旧宿主无 context API）

按 captain 裁决，**「agent 侧下一 step 注入」不作为 v2 交付项**（全局作用域拿不到 agent 实例、导入内部模块违反抗升级、user 消息绕开会破坏消息序列与 transcript）。因此旧宿主上的降级上限就是「仅 section 锚」，判定标准写死如下：

- **触发条件**：`typeof ctx.systemPrompt.context !== 'function'`（宿主 `@deepseek-ai/dsh-system-prompt` 早于引入 `context()` 的版本），或部署显式设置 `requestTail: 'off' | false` / `requestEnabled: false`。
- **表现**：只剩 4 个 section（头锚 `-900`、子智能体锚 `-880`、mid `5100`、尾部锚 `90050`），**没有 per-request runtime-context 尾注**；`logger.debug` 记录 `[lang-rule] 宿主无 systemPrompt.context()，per-request 通道降级 { name: 'lang-rule:request-tail' }` 与 `skipped: [{ kind: 'context', reason: 'context-api-unavailable' }]`；不抛错、不阻断 dsh 启动。
- **如何自查**：`node tools/verify-installed.mjs --strict`，看 `per-request 约束出现在会话里` 一项：
  - `PASS` = 已找到证据；
  - `WARN` = 最近扫描窗口内还没有 v2 安装后的新会话（不误判）；
  - `FAIL` = v2 已装进 profile，且安装后已产生新会话，但 0 条 context 证据 → 插件处于 degraded 或未生效，检查宿主版本与 `requestTail` 配置。
  - 若用 `--plugin` 指向未安装的工作副本，不做 FAIL 判定（避免误报），detail 会说明「当前检查的是未安装副本」；该模式下「v2 安装后新会话」计数为 0，属正常，不代表通道失效。

---

## 工具

```bash
# 注册契约自检（假 ctx，32 项断言，退出码 0 = 全过）
node tools/selftest.mjs

# node:test 单测 8 项：per-request 去重、requestTail=off 回退、config 归一化、order、同名冲突
node --test tools/selftest.test.mjs

# 安装验证（只读）：profile 注册 / 包完整 / system 锚 / runtime-context 证据
node tools/verify-installed.mjs            # --json / --strict / --profile web / --plugin <目录>
# 注：从仓库根执行；--plugin 支持相对或绝对路径（相对 cwd 找不到时会回退按插件根解析）

# 语料复测（只读）：逐段首句语言、首个英文段、按锚阶段分层
node tools/lang-audit.mjs --json
node tools/lang-audit.mjs --limit 200 --verbose
```

`verify-installed.mjs` 输出 PASS / WARN / FAIL：FAIL 退出码 1；WARN 表示「已安装版本是 v1，或还没有 v2 新会话可供取证」。

---

## 与 58fly/dsh-language-guard 的差异

竞品里综合评分最高的 58fly/dsh-language-guard（40/45）用的是「工具文档之后重申一段约 146 字符约束（order 5100）+ 周期性提醒」，其 README 自认 **Subagents are skipped**（子会话只继承系统提示、周期提醒不覆盖）。v2 与之的差异：

| 维度 | 58fly | dsh-lang-rule v2 |
| --- | --- | --- |
| 约束口径 | 「用中文」 | **首句**必须中文 + 禁英文祈使句起手（对应 t1 的 81.1% 条件概率） |
| 子会话覆盖 | 跳过 subagent | 子智能体强化锚 + per-request context 对全部 agent 作用域生效 |
| 位置 | mid 段 | mid 段 + 尾部锚 + **per-request context**（每请求重新渲染，落在 claimed 之后） |
| 可量化 | 无判据 | `tools/lang-audit.mjs --json` 按锚阶段分层，直接给英文主导率/首句英文率 |

mid 段的 order 5100 借鉴了它的实测结论（工具 schema 5000 之后仍有约束力）；我们没有照抄任何「英文 CoT + 中文输出」的实现。

## 安装

从 GitHub 安装（推荐）：

```bash
dsh plugin --profile <your-profile> add github:ArthurZhu1992/dsh-lang-rule
```

`<your-profile>` 换成你的 profile 名，例如 `desktop`（桌面端默认）或 `web`。安装后重启 DSH。

从本地副本安装（等价，便于调试）：

```bash
git clone https://github.com/ArthurZhu1992/dsh-lang-rule
dsh plugin --profile <your-profile> add file:/absolute/path/to/dsh-lang-rule
```

或用插件管理器：`plugin_manager { action: "install_bundle", target: "dsh-lang-rule" }`。

卸载：

```bash
dsh plugin --profile <your-profile> remove dsh-lang-rule
```

卸载后确认 profile 的 `package.json` 里 `dsh.profile.bundles` 不再包含 `dsh-lang-rule`，重启 DSH。

---

## 已知限制

- per-request 通道依赖宿主把 runtime context 快照 append 在 claimed 消息之后（dsh 0.2.2-rc.3 行为）。宿主若改动该投影顺序，约束的「最靠后」性质会退化；用 `tools/verify-installed.mjs`、`tools/lang-audit.mjs` 复测 `head+tail+request` 层即可发现。
- AgentTeams 英文分派模板本身不在本插件范围内（不能改 AgentTeams），插件只能在提示词侧抵消。
- 插件不能保证每次都输出中文：它把「首句英文率」和「英文主导率」压到尽可能低，量化验收由外部 harness 用 `lang-audit --json` 的 `summary.byAnchorLayer` 完成。

## 证据文件

- `docs/DESIGN.md` — 设计决策、order 推导、宿主源码定位、审计数据来源
- `tools/*.mjs` — 自检 / 单测 / 安装验证 / 语料复测
