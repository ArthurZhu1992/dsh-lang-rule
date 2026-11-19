# dsh-lang-rule

## 所思所言，皆成中文

**DSH 起笔即中文，一线到底。**

首句是中文，往下就都是中文；首句滑成英文，整段跟着走——264 个会话里，81.1% 如此。
一个人说中文容易，一支队伍都说中文才算数：主 agent、子智能体、AgentTeams、workflow 子智能体、后台任务。
不必信它，跑一条 `verify-installed --strict`，看它在你机器上到底有没有生效。

---



## v3 的依据：我们自己的实测（不是竞品文案）

| 证据 | 数值 | 它推翻的假设 |
| --- | --- | --- |
| v2 首句英文率（n=16 probe） | **25.0%**，Wilson 95% CI **[10.2%, 49.5%]** | 与 v1 的 28.2% **区间重叠** → v2 的「黑名单 + 尾锚」没把首句压下去 |
| 已见英文起手（4 种） | `Let me start by…`、`The user asks…`、**`The user wants…`**、**`The task: …`** | 后两种 **不在 v2 默认黑名单** → 枚举永远不完备 |
| 首句中文 ≠ 整段中文 | 63,443 字符 / 21 段：首句中文但整段 CJK **0.222**；406 字符 / 1 段：整段 CJK **0.910** | 「首句中文 = 整段中文」是错的 → 必须把首句与整段拆成两个指标 |
| 工具调用越多约束越淡 | 长任务里约束被稀释 | 静态锚 + 固定文本会因「整包去重」只 append 一次 |

所以 v3 只做四件事：

1. **判据换轨（最重要）**：`第一句必须包含中文字符（U+4E00–U+9FFF），不得以 ASCII 字母开头`。两条都能用正则直接判真假。
2. **中文 few-shot**：2 个极短正确示范（总长 41 字符），给模型可模仿的形状，不用英文示例。
3. **step 级变体**：context 文本在 3 个变体间轮换（基础 / 「包括这一句」/「工具结果之后」），按 assembly（通常每 step 一次）轮换；整包 sections 每次不同 → 每步都会重新 append，约束不被稀释。`config.contextVariant = false` 可回到固定文本。
4. **指标拆开**：`lang-audit` 把「首句语言」与「整段 CJK 占比」分别输出，并按长任务（>10000 字符或 >10 段）分组。

---

## 为什么首句比长度更重要（v1/v2 全量审计）

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

完整审计报告与复现脚本见仓库发布的 `LANG-AUDIT.md`（由 `tools/lang-audit.mjs` 生成 JSON）。

---

## 五通道设计（v3：order 与 v2 完全一致，未新增通道）

| # | 通道 | order | 位置 | 作用 | 默认文本长度 |
| --- | --- | --- | --- | --- | --- |
| 1 | `section` `lang-rule` | **-900** | harness 身份段（-1000）之后、部署 persona（0）之前 | 长版铁律：定性「全程中文、不得用英文思考」 | ≈165 字符 |
| 2 | `section` `lang-rule:subagent` | **-880** | 紧跟头锚 | 显式点名 subagent / AgentTeams 成员 / workflow 子智能体 / 后台任务 | ≈53 字符 |
| 3 | `section` `lang-rule:mid` | **5100** | 工具 schema（TOOLS_SDK=5000）之后、结构化输出（9900）之前 | 工具文档后再重申一次可判定首句判据 | ≈106 字符 |
| 4 | `section` `lang-rule:tail` | **90050** | 全部宿主 section 之后 | 尾部首句锚：第一句必须含中文字符、不得以 ASCII 字母开头 + 正确示范 | ≈51 字符 |
| 5 | `context` `lang-rule:request-tail` | **500** | 宿主 context 上界（WEB_SURFACE=210）之后；每个 step 由宿主把 runtime-context 快照 append 在 claimed 消息之后 | **per-request 通道**：每请求重新渲染；模型看到的是宿主生成的 user 角色 `<system-reminder>` 快照，位于本 step 最后。**v3 起文本按 assembly（通常每 step 一次）在 3 个变体间轮换** | 73–137 字符（随变体） |

> 文本预算变更：请求尾从 v2 的 ≤80 字符放宽到 **≤150 字符**（v3 变体 1 实测 137 字符，多出的是可判定判据句与 few-shot）；`selftest.mjs` 对每个变体断言 ≤150。其余通道预算不变（头 ≤250 / 子 ≤60 / mid ≤150 / 尾 ≤80）。

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

## token 成本（1.0.0）

成本结构分两层，**别混在一起算**：

1. **system prompt 的四个 section**（head / subagent / mid / tail）每次请求都要发，但文本固定 → 命中 prompt cache 后边际成本接近 0；只有首次或缓存失效时全价。
2. **per-request context**（`lang-rule:request-tail`）每次 append 在请求末尾，不在可复用前缀里 → 每次全价。这一层是真正需要控的。

估算口径：中文按 1 token/字（保守上界）、非中文按 4 字符≈1 token；区间给「中文 0.6–1 token/字」两端。`estimateTokens()` 导出同一口径，selftest 用它断言预算。

| 常量 | 字符 | token 估算（区间） |
| --- | --- | --- |
| `HEAD_TEXT`（full） | 157 | 94–157（点估 115） |
| `HEAD_TEXT_COMPACT`（standard） | 56 | 34–56（点估 47） |
| `SUBAGENT_TEXT` | 55 | 33–55（点估 36） |
| `MID_TEXT`（full） | 106 | 64–106（点估 61） |
| `MID_TEXT_COMPACT`（standard） | 32 | 19–32（点估 25） |
| `TAIL_TEXT` | 51 | 31–51（点估 39） |
| `REQUEST_TEXT`（full 变体 1） | 137 | 82–137（点估 86） |
| `REQUEST_TEXT_COMPACT`（standard 变体 1） | 46 | 28–46（点估 34） |

### 三档 preset

| 档 | 注册通道 | 每次请求字符（section + context） | token 估算（区间） | 预算 |
| --- | --- | --- | --- | --- |
| `minimal` | tail + context | 51 + 137 = 188 | 77–112（点估 125） | ≤130 |
| `standard` | head + subagent + mid + tail + context（紧凑文本，无 few-shot） | 56+55+32+51 + 46 = 240 | 114–175（点估 181） | ≤300 |
| `full`（默认） | 五通道（完整文本 + few-shot） | 157+55+106+51 + 137 = 506 | 232–352（点估 337） | ≤400 |

> minimal 仍保留**可判定首句判据**与 **per-request 注入**（不是靠删功能省 token）；standard 的五通道与判据同样完整，只是把示例句与枚举提示压缩掉了。

### 变体策略与 20 step 成本

宿主对 runtime-context 快照的去重单位是**整包 sections**：文本不变 → 不重复 append；文本变 → 整包重发。所以「多久变一次」直接决定长任务成本：

| `contextVariant` | 行为 | 20 step 的 context append 次数 | 20 step 增量（full，点估 86/次） | append/step |
| --- | --- | --- | --- | --- |
| `off`（= v2 行为） | 固定文本，只 append 一次 | 1 | ≈86 token | 0.05 |
| `lazy`（**默认**） | 每 3 个 **step** 切换（第 1/4/7/10… 步）+ 工具结果后的下一个 step 整段用「工具结果之后」 | 7（+每次工具结果 1 步） | ≈602 token | **实测 0.479**（开发期 3.1.2 多步会话基线；部署后需复跑 measure-appends）；20 step 模拟 0.35；开发期 3.1.0 实测 0.783（按调用计数被放大） |
| `step` | 每 step 切换 + 工具结果后的下一个 step 整段用变体 3 | 20 | ≈1720 token | 1.00 |

> 三个数字的来源与差异：
> - **0.783**（开发期 3.1.0 实测，long 组）：按 provider 调用次数计数，宿主一 step 多次调用把 lazy 放大。
> - **0.35**（20 step × 2 次调用的机制模拟）：理想节奏下的下界。
> - **0.479**（开发期 3.1.2 实测，多步会话；t37 数据 `work/lang-rule-tests/out/V3.1.2-VERIFY.json#append.appendPerStepMultiStep`）：真实宿主的调用节奏（一 step 内多次 assembly + 工具结果触发的额外切换）——这是当前应引用的实测值。
> - **0.479 是开发期 3.1.2 的基线，不是 1.0.0 的定值**：1.0.0 把「工具结果之后」变体扩到整个下一个 step（命中率 1/3 → 3/3），理论上会让 lazy 成本略微抬高；部署 1.0.0 后需复跑 `node tools/measure-appends.mjs` 更新本表。
> - 总体（含 1 步短会话）为 0.606；单条 1 步会话（`03d5a353`）为 0.5，样本过小不作结论。

### 为什么 lazy 曾经没兑现（开发期修复）

t24 批量实测（`work/lang-rule-tests/out/request-appends.json`）long 组 **append/step = 0.783**（13.1 step / 10.3 次 append），而不是设计的 0.33。原因：

> **宿主在一个 step 内可能多次调用 context provider** —— `preStep()` 里的 `systemPrompt.assemble()`、step 内的 `refreshContext()`、以及失败重试，都会触发 provider。开发期 3.1.x 按「provider 调用次数」计数，于是「每 3 次调用切换」实际变成「每 1–2 个 step 就切换」，成本节省没有兑现。

开发期修复（已并入 1.0.0）：

1. **按 step 计数**：优先监听宿主 `session/event` 的 `step/start` 精确推进 step；事件不可用（`ctx.on` 缺失、签名不符、或全局收不到 agent 事件）时，退回「同一 signal + 距上次调用 <1500ms 视为同一 step」的时间窗启发式。
2. **工具结果后立即切换**：`tool/result` 之后的**下一个 step** 强制使用「工具结果之后」变体，不等 3 步轮换。这直接覆盖 mid 场景（只读 1–2 个文件、2–3 段，工具结果紧贴采样点）。

实测/复现：

```bash
node tools/measure-appends.mjs                 # 读最近会话：step 数、append 次数、append/step
node tools/measure-appends.mjs --session 03d5a353
node tools/measure-appends.mjs --dry-run       # 不读会话，只跑 20 step × 2 次调用的机制模拟
# 结果落盘 out/appends.json，含 observed / simulated / theory 三段
```

> 路径约定：本脚本默认输出 `work/dsh-lang-rule/out/appends.json`；harness 侧的批量数据在 `work/lang-rule-tests/out/request-appends.json`（开发期 3.1.0 旧口径，由测试架构师产出）。两者可用 `--out <path>` 对齐，内容字段一致。

`--dry-run` 模拟（20 step × 2 次 provider 调用）：`off 1 次 / 0.05`、`lazy 7 次 / 0.35`、`step 20 次 / 1.00`；修复前 t24 实测 long 组为 `0.783`。修复后 lazy 的理论值为 `0.33–0.5`（工具结果越密越高），显著低于修复前的 0.783。**注意 0.35 是模拟值**，真实值以部署后新会话的 `measured` 输出为准。

选型建议：

- 只要「首句中文」的最低成本：`preset: minimal`（tail + context，点估 125 token/请求）。
- 默认推荐：`preset: standard` + `contextVariant: lazy`（点估 181 token/请求，五通道齐全）。
- 约束最强、不在乎成本：`preset: full` + `contextVariant: step`（点估 337 token/请求，每步重发）。
- 完全对齐 v2 成本：`contextVariant: off`。

---

## 配置

全部为可选键，默认值即推荐值。**v1 的 `text` / `order` / `sectionName` / `tailText` / `tailOrder` / `tailSectionName` / `tailEnabled` 继续有效。**

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时不注册任何通道（基线对照） |
| `preset` | `'full'` | **1.0.0**：`minimal`（tail + context，点估 125 token）/ `standard`（五通道紧凑文本，点估 181）/ `full`（完整文本 + few-shot，点估 337）。见 [token 成本](#token-成本100) |
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
| `requestText` | 内置 | per-request 约束正文（显式设置后覆盖变体，回到固定文本） |
| `contextVariant` | `'lazy'` | **1.0.0**：`'off'`（固定文本，只 append 一次，等同 v2 成本）/ `'lazy'`（默认，每 3 个 **step** 切换，约 1/3 成本）/ `'step'`（每 step 切换）。两者都接「工具结果后立即切换」。旧布尔兼容：`false`→`off`、`true`→`step` |
| `requestOrder` | `max(500, 宿主 context 上界+100)` | per-request context order |
| `requestSectionName` | `lang-rule:request-tail` | per-request context 名 |

示例（profile 的 cordis 配置）：

```yaml
- id: dsh-lang-rule
  name: dsh-lang-rule
  config:
    preset: standard          # minimal | standard | full（默认 full）
    requestTail: context      # off / false = 回到 v1 行为
    contextVariant: lazy      # off | lazy | step（默认 lazy）
    tailOrder: 90050
```

---

## 首句判据与锚文本（v3）

**主判据（可判定）**：`本步 reasoning 第一句必须包含中文字符（U+4E00–U+9FFF），不得以 ASCII 字母开头。`

**辅助提示（黑名单）**：`Let me / Let's / I'll / We need to / The user wants / The task: 都不算中文首句。`
标注为「**枚举永远不完备**」——实测 `The user wants…` 与 `The task: …` 就不在 v2 默认黑名单里，所以黑名单**不得作为唯一判据**。

**few-shot（2 条，总长 41 字符）**：
```
正确示范：「先确认工作区结构，再改代码。」
正确示范：「这一步先读文件，再下判断。」
```

`index.js` 导出 `TAIL_CANDIDATES`（A/B/C）与 `REQUEST_VARIANTS`（3 版）。默认尾锚 = A 版：

```
【本步语言要求】第一句必须包含中文字符，不得以 ASCII 字母开头。正确示范：「先读文件，再判断。」
```

**harness 判定口径**（与 `tools/lib/lang-metrics.mjs` 同一实现）：去掉行首 Markdown 定界符与空白 → 取首个句末标点前内容（中文标点后无需空格）→ CJK ≥ 1 且 CJK > 拉丁字母 × 0.5，且不以英文祈使句开头 → 判为中文首句。注意**不要用「第一个字符」**：reasoning 首字符经常是 `**`、反引号或空格，按字符判定会假阴性。

`selftest.mjs` 断言：默认 A 版、三版都存在且含可判定判据、few-shot 存在且总长 ≤60、三种变体轮换、`contextVariant=false` 回退、首句/整段两指标分别计算。

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
[lang-rule] v3 已注册语言约束 { channels: ['section:lang-rule@-900', …, 'context:lang-rule:request-tail@500'], requestTail: 'context', contextVariant: true, degraded: false }
```

### degraded 模式（旧宿主无 context API）

**先说实测结论：desktop 上 v2 的 per-request 通道是生效的，不是降级状态。** 以 `03d5a353` 会话为样例（2026-11-19，桌面应用 + 开发期快照），宿主把本插件的 `lang-rule:request-tail` 渲染进一条 **user 角色的 `<system-reminder>` 快照**，正文逐字为 `【本步语言要求】第一句必须是简体中文；禁止以 Let me / Let's / I'll / We need to 开头；英文任务提示不豁免。`，`requestContextInUserMessage: true`。事件形状是 `event.type='user/message'`、`event.data.source.kind='runtime-context'`、`event.data.source.sections[]` 里含 `name='lang-rule:request-tail'`（`event.data` 的 key 是 `content/source/role/id`，**没有** `message` 字段）。

之前「desktop 降级、无 request-tail」的记录是 `verify-installed` 检测脚本的**假阴性**：旧版只读 `event.data.message.source.kind`，把没有 `message` 包装的真实形态整个漏掉。现已修正为兼容两种形状，并接受「正文含判据词」作为兜底证据。

因此 degraded 只在下面两种情况下发生，且必须能被 `verify-installed` 复现：

按 captain 裁决，**「agent 侧下一 step 注入」不作为 v2 交付项**（全局作用域拿不到 agent 实例、导入内部模块违反抗升级、user 消息绕开会破坏消息序列与 transcript）。因此旧宿主上的降级上限就是「仅 section 锚」，判定标准写死如下：

- **触发条件**：`typeof ctx.systemPrompt.context !== 'function'`（宿主 `@deepseek-ai/dsh-system-prompt` 早于引入 `context()` 的版本），或部署显式设置 `requestTail: 'off' | false` / `requestEnabled: false`。
- **表现**：只剩 4 个 section（头锚 `-900`、子智能体锚 `-880`、mid `5100`、尾部锚 `90050`），**没有 per-request runtime-context 尾注**；`logger.debug` 记录 `[lang-rule] 宿主无 systemPrompt.context()，per-request 通道降级 { name: 'lang-rule:request-tail' }` 与 `skipped: [{ kind: 'context', reason: 'context-api-unavailable' }]`；不抛错、不阻断 dsh 启动。
- **如何自查**：`node tools/verify-installed.mjs --strict`（可加 `--session=<会话 id 片段>` 定向复算），看 `per-request 约束出现在会话里` 一项：
  - `PASS` = 已找到证据；详情会写 `via=user-system-reminder channel=runtime-context 命中 section=lang-rule:request-tail`（或 `marker=…`），
    说明注入形态是宿主生成的 user `system-reminder` 快照，不是普通用户输入；
  - `WARN` = 最近扫描窗口内还没有 v2 安装后的新会话（不误判）；
  - `FAIL` = v2 已装进 profile，且安装后已产生新会话，但 0 条 context 证据 → 插件处于 degraded 或未生效，检查宿主版本与 `requestTail` 配置。
  - 若用 `--plugin` 指向未安装的工作副本，不做 FAIL 判定（避免误报），detail 会说明「当前检查的是未安装副本」。
  - 证据检测兼容两种事件形状：`event.data.source`（真实 runtime-context 快照）与 `event.data.message.source`（旧形状）；命中 `lang-rule:request-tail` section 名或正文判据词任一即计入。

---

## 工具

```bash
# 注册契约自检（假 ctx，53 项断言，退出码 0 = 全过；含工具结果跨 step 用例）
node tools/selftest.mjs

# node:test 最小单测：per-request 去重 + requestTail=off 回退 + v3 变体 provider
node --test tools/selftest.test.mjs

# 安装验证（只读）：profile 注册 / 包完整 / system 锚 / runtime-context 证据
node tools/verify-installed.mjs            # --json / --strict / --profile web / --plugin <目录> / --session <会话id片段>
# 注：从仓库根执行；--plugin 支持相对或绝对路径（相对 cwd 找不到时会回退按插件根解析）

# 语料复测（只读）：逐段首句语言、首个英文段、按锚阶段分层、首句/整段两指标、长任务分组
node tools/lang-audit.mjs --json
node tools/lang-audit.mjs --limit 200 --verbose

# 成本测量（只读）：append/step 与三档模拟
node tools/measure-appends.mjs --dry-run
# 工具结果变体命中率：机制模拟 / 旧实现实测 / 真实 step 序列重放
node tools/measure-tool-variant.mjs --simulate
# ⚠️ 复现 2a6b3aee 必须指向隔离 DSH_HOME（默认 ~/.dsh/sessions 里没有该会话，会「未找到」）
node tools/measure-tool-variant.mjs --replay \
  --sessions-root work/lang-rule-tests/.runtime/dsh-home/sessions \
  --session 2a6b3aee
# 也可用 DSH_SESSIONS_ROOT 指定同一路径；--simulate 不需要会话，可在任意目录跑
```

> **测试钩子 `settings.now`**：`apply(ctx, { now: () => clock })` 可注入假时钟，selftest/harness 用它构造确定性的跨 step 序列（否则时间窗启发式只能依赖真实时钟，无法断言「同 step 多次调用不切换」）。
> 生产部署不要设置它（默认 `Date.now()`）。若 harness 读不到该钩子，static 层只能把时间窗行为记为不可确定性验证（开发期快照的 1 WARN 即来自这里）——插件本身不受影响，仅测试可断言性下降。

`lang-audit --json` 的 `summary` 里 v3 新增两项：

- `firstSentenceVsBody`：`firstZhBodyEn`（首句中文但整段英文主导）/ `firstEnBodyZh` —— 直接暴露「首句中文 ≠ 整段中文」；
- `longTasks`：按 `>10000 字符 或 >10 段` 分 `long` / `short` 两组，各自给首句英文率、整段英文主导率、CJK 中位数。

`verify-installed.mjs` 输出 PASS / WARN / FAIL：FAIL 退出码 1；WARN 表示「已安装版本低于 v2，或还没有 v2+ 新会话可供取证」。

---

## 与 58fly/dsh-language-guard 的差异

竞品里综合评分最高的 58fly/dsh-language-guard（40/45）用的是「工具文档之后重申一段约 146 字符约束（order 5100）+ 周期性提醒」，其 README 自认 **Subagents are skipped**（子会话只继承系统提示、周期提醒不覆盖）。v3 与之的差异：

| 维度 | 58fly | dsh-lang-rule v3 |
| --- | --- | --- |
| 约束口径 | 「用中文」 | **可判定首句**：第一句必须含中文字符、不得以 ASCII 字母开头（黑名单只作辅助） |
| 子会话覆盖 | 跳过 subagent | 子智能体强化锚 + per-request context 对全部 agent 作用域生效 |
| 位置 | mid 段 | mid 段 + 尾部锚 + **per-request context**（每请求重新渲染，落在 claimed 之后） |
| 长任务稀释 | 静态重复 | **step 级变体**：context 文本轮换，整包去重不会跳过，每步重新 append |
| 可量化 | 无判据 | `lang-audit --json` 按锚阶段分层 + 首句/整段拆分 + 长任务分组 |

mid 段的 order 5100 借鉴了它的实测结论（工具 schema 5000 之后仍有约束力）；我们没有照抄任何「英文 CoT + 中文输出」的实现。

## 安装

```bash
# profile 直接引用本地包
# ~/.dsh/profiles/<profile>/package.json
#   "dependencies": { "dsh-lang-rule": "file:../../plugins/dsh-lang-rule" },
#   "dsh.profile.bundles": [ …, "dsh-lang-rule" ]
```

或用插件管理器：

```
plugin_manager { action: "install_bundle", target: "dsh-lang-rule" }
```

---

## 已知限制

- **黑名单永远不完备**：`Let me / Let's / I'll / We need to / The user wants / The task:` 之外仍可能出现新的英文起手（v3 已把黑名单降级为辅助提示，主判据是「第一句必须含中文字符、不得以 ASCII 字母开头」）。新增起手形态应先进 `ENGLISH_OPENER_HINTS` 的候选观察，而不是当成唯一防线。
- **首句中文 ≠ 整段中文**：实测 63,443 字符 / 21 段的任务首句中文但整段 CJK 0.222；v3 用 step 级变体缓解稀释，但不保证整段中文占比达 90%+。
- **step 变体的成本**：v3 请求尾文本 **≤150 字符**（较 v2 的 ≤80 增加，多出的是可判定判据句与 few-shot）。`lazy`/`step` 都会按 step 重发短快照（73–137 字符）；`lazy` 约每 3 step 一次（模拟 0.35 append/step），`step` 每步一次（1.00）。长任务多步时累计有 token 成本，需要省 token 可设 `contextVariant: off` 回到固定文本。
- **lazy 的 step 计数依赖事件或时间窗**：优先用宿主 `session/event` 的 `step/start`；若事件不可用（`ctx.on` 缺失或全局收不到 agent 事件），退回「同一 signal + 间隔 <1500ms 视为同一 step」。若宿主某 step 内的多次 provider 调用间隔超过 1500ms 且事件不可用，step 会被多计、`lazy` 会偏密；用 `tools/measure-appends.mjs` 复测即可发现。
- **成本表里的 0.35 是模拟值**：来自 `measure-appends --dry-run` 的 20 step × 2 次调用模拟；真实样本当前仅 `03d5a353` 一条（append/step 0.5，v2 固定文本期）。1.0.0 部署后需用新会话批量复测（`node tools/measure-appends.mjs`，非 dry-run），复测后更新成本表。
- per-request 通道依赖宿主把 runtime context 快照 append 在 claimed 消息之后（dsh 0.2.2-rc.3 行为）。宿主若改动该投影顺序，约束的「最靠后」性质会退化；用 `tools/verify-installed.mjs`、`tools/lang-audit.mjs` 复测 `head+tail+request` 层即可发现。
- AgentTeams 英文分派模板本身不在本插件范围内（不能改 AgentTeams），插件只能在提示词侧抵消。
- 插件不保证 100% 中文：它把「首句英文率」和「整段英文主导率」压到尽可能低，量化验收由外部 harness 用 `lang-audit --json` 的 `summary.byAnchorLayer` / `summary.longTasks` 完成。

## 证据文件

- `docs/DESIGN.md` — 设计决策、order 推导、宿主源码定位、v3 判据换轨理由、审计数据来源
- `tools/*.mjs`、`tools/lib/*.mjs` — 自检 / 单测 / 安装验证 / 语料复测 / 指标与证据检测纯函数
