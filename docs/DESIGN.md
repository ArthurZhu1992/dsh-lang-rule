# dsh-lang-rule v2 设计说明

本文记录 v2 的每一个设计决策、证据来源与取舍，供门禁审查与后续 harness 复现。

## 1. 问题定义（来自 t1 全量审计）

`work/lang-rule-evidence/LANG-AUDIT.md` 的结论（264 个含 reasoning 会话）：

| 锚阶段 | 会话 | 英文主导率 | 首句英文率 |
| --- | --- | --- | --- |
| 无锚 | 12 | 75.0% | 58.3% |
| 仅头锚 | 73 | 39.7% | 39.7% |
| 头锚 + 尾锚（v1） | 179 | 13.4% | 21.2% |

- 首句英文 → 整段英文 81.1%（60/74）；首句中文 → 整段英文 1.1%（2/190）。
- 4 个已知英文会话头尾锚齐全、尾锚 100% 可见、距 system 末尾 75 字符，但 system 之后仍有 15,621–16,704 字符 user 文本（中位 15,919）。
- 子会话首句英文率 32.5%（68/209）vs 主会话 10.9%（6/55）。

结论：v1 的失败模式不是「锚不够长」，而是「锚不在请求最后」+「首句没有被硬约束」+「子会话漏网」。

## 2. 宿主 API 调研（dsh 0.2.2-rc.3）

app.asar 内 `dsh/node_modules/@deepseek-ai/` 源码。用 `.tmp/asar-extract.mjs` 解析 asar 头（16 字节 pickle + JSON header + base offset）抽取：

### 2.1 system prompt 注册表（`dsh-system-prompt/src/index.ts`）

- `section({name, order, text, interpolate?, complete?})`：order 必须有限数；同层同名重复抛错 → 插件必须 try/catch 并让出。
- `context({name, order, text, interpolate?, required?})`：动态上下文，**模型侧物化为持久 user-role 快照**。
- `getSectionOrder(name)` / `getContextOrder(name)`：公开的中央 order 查询，用于运行时探测上界。
- `SECTION_ORDERS` 上界 `DEPLOYMENT_PERSONA_SUFFIX = 10200`；`CONTEXT_ORDERS` 上界 `WEB_SURFACE = 210`。
- `suppressRuntimeContext()` 会过滤非 `required` 的 context。

### 2.2 每步流程（`dsh-agent-loop/src/agent.ts`）

```
preStep()
  ├─ inbox.claim(target)                        → claimed（本 step 的模型输入）
  ├─ systemPrompt.assemble()                     → 渲染 system
  ├─ dispatch.waterfall('agent/pre-step', …)     → 可改 messages
  │    默认：messages = [...claimed, runtimeContextSnapshot]
  └─ buildRequest() → llm.stream(request)
```

`RuntimeContextProjection.project(sections)`（`runtime-context.ts`）：

- **物化形态**：`createUserMessage({ source: { kind: 'runtime-context', form: 'snapshot' } })` —— 注入的是一条 **user 角色消息**，内容用 `<system-reminder>` 包裹的系统约束文本。它不改写、不拼接真实用户输入，但角色上确实是 user。
- 首次：append 一条快照；
- 后续：`deepEqualJson(previous, sections)` 相同则返回 `undefined`（不 append）；
- 变化：**append 新快照，旧快照保留在 surface**（`agent-loop/src/agent.ts:474/483`：`session.append('user/message', context, { surfaceOp: 'append' })`；没有 replace，`deriveMessages()` 全量派生历史）；
- 清除：写入 `CLEARED` 文本（同样是 append 一条新快照，语义上声明旧快照失效）。

**去重语义的前提**（不能省略）：判重单位是**整包 sections**，不是本插件那一条。宿主自身的 runtime section（working directory、sandbox policy 等）只要有字段变化，整包就会重新 append，本插件的尾注会随整包一起再出现一次。因此准确说法是：

> 只要本 step 的整包 runtime sections 与上一份相同，就不会重复 append；宿主 section 变动时整包重发。

位置不变：快照固定 append 在本 step claimed 消息之后，是模型看到的最后一条消息。

### 2.3 被否决的通道

| 通道 | 否决理由 |
| --- | --- |
| `agent.inject(msg)`（`send(msg,'next-step',false)`） | 追加的是 user 消息，会改变消息序列、可能被 harness 当新回合，且需要持有 agent 实例（插件拿不到） |
| 在最后一条 user 消息尾部拼接 | 污染用户输入语义、改变该轮内容哈希 |
| assistant prefill | 当前宿主 `GenerateOptions` 无此字段 |
| 静态 section 加长 | t1 已证明边际收益极低（head+tail 已到 13.4%） |

## 3. 五通道落位

| 通道 | order | 依据 |
| --- | --- | --- |
| head | -900 | 夹在 `HARNESS_IDENTITY(-1000)` 与 `DEPLOYMENT_PERSONA_PREFIX(0)` 之间，v1 既有 |
| subagent | -880 | 紧跟头锚；子会话是主要漏点（首句英文 32.5%） |
| mid | 5100 | 工具 schema `TOOLS_SDK=5000` 之后、`DELIVERABLE_FILE_REFERENCES=9000` 之前；竞品 58fly/dsh-language-guard 实测 order 5100 有效 |
| tail | 90050 | v1 既有值；`max(90050, 探测上界+1000)`，恒在宿主全部 section（≤10200）之后 |
| request-tail (context) | 500 | 宿主 context 上界 210（WEB_SURFACE）之后，`max(500, 探测上界+100)`；以 user 角色注入的短约束消息（`<system-reminder>` 包裹），位于本 step claimed 之后 |

## 4. 文本与长度预算

| 通道 | 文本长度 | 预算 | 说明 |
| --- | --- | --- | --- |
| head | ≈165 | ≤250 | 删掉 v1 中归子智能体锚负责的那一条，避免重复计费 |
| subagent | ≈53 | ≤60 | 点名 subagent / AgentTeams / workflow / 后台任务 |
| mid | ≈90 | ≤150 | 工具文档后的重申 |
| tail | ≈74 | ≤80 | A 版（最短、判据最稳） |
| request-tail | ≈76 | ≤80 | 与 tail 同组可判定词，固定文本 |

总长约 458 字符（gate-reviewer 预算：头+尾+子 ≤450，mid/request 为额外短句）。

### 4.1 为什么用「第一句」而不是「第一个字符」

gate-reviewer 纠偏：reasoning 首字符常是 `**`、反引号、数字、引号或空格，按字符判定会假阴性。统一用「第一句」，与 harness 判据一一对应：

```
去行首 Markdown 定界符与空白 → 取首句 → CJK≥1 且 CJK > 拉丁字母×0.5 且不以英文祈使句开头 → 中文首句
```

`selftest.mjs` 反向断言尾锚文本**不得**出现「第一个字符」、不得含条件从句（`如果/若/假如/除非`）。

## 5. 去重与 cache 友好

- context 文本是静态字符串（`interpolate: false`）；宿主按**整包 sections** 比较（`deepEqualJson`），整包不变才跳过 append，整包变化则重发（我方尾注随之重复一次）。插件导出的 `requestTailNeedsCommit(previous, next)` 就是按整包 sections 顺序比较的等价判据；
- 因此 selftest / node:test 断言的是「同一份整包 sections 连续出现时只提交一次」，而不是「一次注入永不重复」；
- `compaction` 清除快照后（`CLEARED`）会重新注入，判据覆盖该路径。

## 6. 降级矩阵

| 场景 | 行为 | 断言位置 |
| --- | --- | --- |
| `systemPrompt` 缺失 | 直接 return | selftest「systemPrompt 缺失」 |
| `section()` 抛错 | 跳过该条，其余继续 | selftest「section()/context() 抛错」 |
| `context()` 不存在 | degraded 到 4 section | selftest「旧宿主无 context()」 |
| `logger` 缺失 / 抛错 | 吞掉 | selftest「logger 缺失」「logger 抛错」 |
| config 为 null/字符串 | 按默认值注册 | selftest「config 非对象」 |
| `requestTail:'off'` / `false` / `requestEnabled:false` | 0 context、4 section | selftest + node:test |

### 6.1 degraded 上限（captain 裁决，不实现 agent 侧注入）

**实测事实（2026-11-19，dsh desktop + v2.0.0）**：per-request 通道在 desktop 上 **生效**。样例 `03d5a353`：宿主把 `lang-rule:request-tail` 渲染进一条 user 角色的 `<system-reminder>` 快照，`event.data.source.kind='runtime-context'`、`source.sections[]` 含 `name='lang-rule:request-tail'`，正文逐字等于 `REQUEST_TEXT`（`requestContextInUserMessage: true`）。事件 `data` 的 key 是 `content/source/role/id`，**没有 `message` 字段**。

此前「desktop 降级」的结论来自 `verify-installed` 的假阴性：旧检测只读 `event.data.message.source.kind`，漏掉了无 `message` 包装的真实形态。现检测器（`tools/lib/request-tail-detect.mjs`）兼容两种形状，并在详情标注 `via=user-system-reminder channel=runtime-context` 与命中的 section 名/判据词。

**degraded 只在两种情况发生**：① 宿主没有 `systemPrompt.context()`；② 部署抑制 runtime context 且连 `required: true` 条目也不保留。两者都必须能被 `verify-installed --strict` 复现（否则视为检测缺陷，不是宿主结论）。

旧宿主无 `context()` 时**不退回 agent 侧下一 step 注入**。理由：插件 `apply` 在全局作用域拿不到 agent 实例、导入宿主内部模块违反抗升级、用 user 消息注入会改变消息序列与内容哈希并可能污染 transcript。

- 判定：`typeof ctx.systemPrompt.context !== 'function'`；
- 表现：只有 4 个 section，无 per-request 尾注，`logger.debug` 记录 `context-api-unavailable`；
- 自查：`verify-installed --strict` 的 `per-request 约束出现在会话里` 项 —— 已安装 v2 且产生了新会话却 0 证据时判 FAIL；无新会话时 WARN；检查未安装副本时不判 FAIL。

## 7. 验收与复测

外部 harness（t3/t5）应使用：

```bash
node tools/lang-audit.mjs --json
```

读 `summary.byAnchorLayer` 的 `head+tail+request` 层：

- 英文主导率目标 `<3%`（基线 13.4%）；
- 首句英文率目标 `<5%`（基线 21.2% / 全量 28.0%）。

`tools/verify-installed.mjs` 用于确认部署侧真的装上了 v2：头部锚、尾部锚出现在 system，per-request 约束出现在 `runtime-context` 快照。

## 8. v3：判据换轨（可判定首句）

### 8.1 为什么换

| 证据 | 数值 | 结论 |
| --- | --- | --- |
| v2 首句英文率（n=16） | 25.0%，Wilson 95% CI [10.2%, 49.5%] | 与 v1 的 28.2% 区间重叠 → 黑名单 + 尾锚没有把首句压下去 |
| 已见起手 | `Let me start by…`、`The user asks…`、`The user wants…`、`The task: …` | 后两种不在 v2 黑名单 → **枚举永远不完备** |
| 首句中文 ≠ 整段中文 | 63,443 字符 / 21 段：首句中文但 CJK 0.222；406 字符 / 1 段：CJK 0.910 | 必须把首句指标与整段指标拆开 |
| 工具调用越多越稀释 | 长任务里静态锚作用下降 | 固定文本因整包去重只 append 一次 → 需要 step 级变化 |

### 8.2 改了什么（不改注入机制）

- **判据**：`第一句必须包含中文字符（U+4E00–U+9FFF），不得以 ASCII 字母开头`。两条都能被正则直接判定；黑名单（`ENGLISH_OPENER_HINTS`）降级为辅助提示，并在 README/DESIGN 标注「枚举永远不完备」。
- **few-shot**：`FIRST_SENTENCE_FEW_SHOT` 2 条中文正确示范，总长 41 字符（≤60 预算），不含英文示例。
- **step 级变体**：`REQUEST_VARIANTS` 3 版（基础 / 「包括这一句」/「工具结果之后」），`createRequestVariantProvider()` 每次 assembly 调一次、按 3 轮换。整包 sections 每次不同 → 宿主每步重新 append，约束不被稀释。`config.contextVariant = false` 回退固定文本（等同 v2）。
- **成本**：每 step 多一条 73–137 字符的快照；长任务累计有 token 成本，可关闭。

### 8.3 指标拆分

`tools/lib/lang-metrics.mjs` 提供纯函数，`lang-audit` 与 `selftest` 共用：

- 单段：`segmentMetrics()` 同时给 `firstLanguage`（首句语言）与 `cjkRatio`（整段 CJK 比），字段 `firstSentenceIsZh` / `bodyIsZhDominant` 分开；
- 会话：`summary.firstSentenceVsBody` 给「首句中文但整段英文主导」的交叉计数；
- 分组：`summarizeLongTasks()` 按 `>10000 字符 或 >10 段` 分 `long` / `short`，两组各自算首句英文率、整段英文主导率、CJK 中位数。

首句判定的 v3 修正（两条，都与锚文本判据一一对应）：

1. 中文句号/问号/叹号后**不需要空格**也切分（v2 的实现要求后随空白，导致「中文首句 + 紧跟英文正文」被误判为英文首句）；
2. `firstSentenceLanguage()` 先判首字符：去装饰后若首字符是 `[A-Za-z]` 直接判 `en`，实现锚文本第二条「不得以 ASCII 字母开头」。因此 `OK 我先确认…`、`Sure 这一步…` 不会再被算成中文首句；`segmentMetrics().firstSentenceIsZh` 复用同一函数，判据与测量不会各说各话。

## 9. 未解决 / 后续

- AgentTeams 英文分派模板是 a 类入口（53/62 英文会话首条 user 即该模板），但修改它不在本插件范围；插件只能在提示词侧抵消。
- 宿主若改变 runtime context 投影顺序或去重语义，需重新审计。`verify-installed.mjs` 的 D 层与 `lang-audit` 的 `requestTail` 证据可第一时间发现退化。
- v3 的实测收益需要 v3 vintage 的新会话数据（t22 的批量验证）；在此之前只能引用 v2 probe 的 n=16 结论。

## 10. v3.1：token 预算设计

### 10.1 成本结构

| 层 | 每次请求是否重发 | cache 行为 | 结论 |
| --- | --- | --- | --- |
| system prompt 四 section（head/subagent/mid/tail） | 是，但在可复用前缀里 | 固定文本 → 命中 prompt cache 后边际≈0 | 不是主要成本 |
| per-request context（request-tail） | 是，append 在请求末尾 | 不在前缀里 → **每次全价**；整包去重可跳过重复 | 真正的成本项 |

### 10.2 两个旋钮

- `preset`：管「发什么」。`minimal`=tail+context；`standard`=五通道+紧凑文本；`full`=五通道+完整文本+few-shot。
- `contextVariant`：管「多久变一次」。`off`=固定（去重后只 append 一次）；`lazy`=每 3 次 assembly 切换（第 1/4/7/10… 次）；`step`=每次切换。

两者正交：`preset` 决定注册通道与文本，`contextVariant` 只影响 context 的 provider 形态（`off` 为字符串，`lazy`/`step` 为函数）。

### 10.3 为什么默认 `lazy` 而不是 `step`

v3.0.0 的 `step` 变体在长任务里每步重发一条约 137 字符（点估 86 token）的快照：20 step ≈ 1720 token，且随步数线性增长。`lazy` 把切换点放到第 1/4/7/10… 次 assembly（20 step 约 7 次 ≈ 602 token），仍保留「工具结果之后仍然要中文」的变体语义；`off` 则完全回到 v2 的一次 append。

### 10.4 预算口径与断言

`estimateTokens(text)` = 中文字符数 + 非中文字符数/4（向上取整），是保守上界；README 同时给「中文 0.6–1 token/字」的区间。selftest 断言：三档总估算（minimal ≤130 / standard ≤300 / full ≤400）、单常量长度（HEAD ≤160 / SUBAGENT ≤60 / MID ≤110 / TAIL ≤60 / REQUEST ≤140）、`lazy` 在 12 步内只在第 1/4/7/10 次切换、`off` 与 `step` 的 provider 形态。

### 10.5 不允许用省 token 削弱判据

`minimal` 仍必须含「第一句必须包含中文字符 / 不得以 ASCII 字母开头」与 per-request 注入；`standard` 仍必须覆盖五通道。selftest 的「功能不缩水」用例把这两条钉死。
