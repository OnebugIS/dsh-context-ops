# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.5] - 2026-10-30

### 修复
- 交接提醒不再要求未经确认自动写入 `CHECKPOINT.md`；统一为展示 brief、请求确认后再写盘。
- 对 tokenMeter、缓存投影和历史 usage 的非法数字做安全降级；修正 cache-write 参与缓存口径。
- 校验 `handoffAt >= remindAt`，修正窗口来源标签、压缩经验线和中英文文案。

### 测试

- 43 项测试全部通过。

## [0.1.4] - 2026-10-30

本次审查加固：交接确认安全、坏读数降级、阈值关系校验、窗口来源与缓存口径修正；此前版本的 `realWindow` 字段文案也已修正：它未配置 `realWindows` 时返回的是型号**标称值**，原文案却称之为「真实上下文上限」，容易被读成实测读数，进而误判可以调高 profile 的 `contextWindow`。

### 修复（仅文案，计算逻辑未动）

- **`context_pressure` 工具 description**：「真实窗口 window」→「有效窗口 window（= min 声明值与该路由上限）」。
- **`realWindow` 字段描述**：改为「该路由的容量上限估计：`realWindows` 配了实测值则用它，否则退回内置标称值（型号通用规格，不代表当前线路实测支持）」。
- **诊断技能**：`min(声明窗口, 真实窗口)` → `min(声明窗口, realWindow)`，并补「**不是实测值**」。
- **决策技能**：`min(声明窗口, 该路由真实上限)` → `min(声明窗口, realWindow)`（同一歧义，一并修）。
- **README**：`realWindow` 字段表同步；项目结构里的「真实窗口」改为「标称窗口表」。

### 不变

- `windowFields()` 计算逻辑、`MODEL_REAL` 标称表、`window` / `pct` / `windowInflated` 取值**均未改动**。
- `realWindows` 未配置时的行为与 0.1.3 一致。

### 测试

- 39 项（0.1.3 为 38）：新增「字段文案不得把标称值说成真实上限」，锁住 `realWindow` / `window` 两个字段描述里不得再出现「真实上下文上限」「真实窗口」。

## [0.1.3] - 2026-10-28

修正 0.1.2 里 `windowSource` 的判定口径：它应当标记**实际限制有效窗口的那个值**，而不是「配置表里有什么」。

### 修复

- **`windowSource` 判定改为按「谁等于 window」**。0.1.2 只要配了 `realWindows` 就报 `override`，且只要型号在标称表里就报 `nominal`；于是当 profile 声明值更小时会出现标签与数字矛盾：声明 800,000、标称 1,048,576 时，真正决定 `window` 的是声明值，却标成 `nominal`，诊断据此误提示「窗口由标称值限制，建议实测」——而用户其实早已实测过。
  现在按 `window === override / nominal / declared` 判定（多值相等时优先报有证据含义的 `override`，其次 `nominal`）。
- **诊断告警按来源分三支**：`nominal` / `declared` / `unknown` 各给各的话术，不再一律说「未实测」。`declared` 的说法改为「插件无法判断该值的依据（官方资料 / 针尖测试 / 人工设定）」，不再暗示「未经校准」。
- **`WINDOW_EVIDENCE` 文案同步**：四个来源都改为描述「谁在限制有效窗口」。

### 不变

- `window`、`pct`、`windowInflated` 与所有处方结论**完全不变**，只改标签与配套文案。
- 未配置 `realWindows` 的线路行为不变；不填时的读取结果与 0.1.2 一致。

### 测试

- 38 项（0.1.2 为 37）：新增「声明窗口更小 → 来源为 `declared`」用例；把「声明偏小是合法限制」用例的期望来源由 `nominal` 改为 `declared`。

## [0.1.2] - 2026-10-28

对齐《上下文管理：分层操作手册》2026-10-28 增补内容（§1.5 中转线路必须实测、§1.6 针尖测试、§3.1 overflow 即事实上限、§4.5 自动压缩参数、§5.1 五条交班触发、§7 避坑清单）。

### 新增

- **`realWindows` 配置**：按 `provider/model` 填写实测安全窗口，用于覆盖内置标称值。
  - 键必须带 provider —— 同一型号在不同线路容量不同，只写型号会报错（宁可报错，也不要把一条线路的实测值错用到另一条）。
  - 没配置的线路行为不变（退回标称值），升级不影响现有 profile。
  - 实测值只是"天花板的上界提示"，有效窗口仍取 `min(声明窗口, 实测值)`，不会放大窗口。
- **`context_pressure` 新增 `windowSource`**：说明窗口数字的证据来源（`override` 实测配置 / `nominal` 内置标称 / `declared` 仅声明值 / `unknown`）。
  - 用途：让诊断能区分「这个百分比是按实测算的」和「这个百分比只是按标称值算的」，不再把两者混为一谈。
- **`context_pressure` 新增 `routeKey`**：直接给出 `provider/model` 键，用户可原样粘进 `realWindows`，不用自己拼。
- 诊断技能新增「窗口证据来源」段与告警项：`windowSource ≠ override` 时明确写「未实测」，并给出怎么实测、怎么填。

### 修复（对齐手册新增判据）

- **交班硬触发补第 4 条**：`400 Content Exists Risk`（内容审核锁死）。原来只有 4 条，漏了这条会导致在同会话里反复挣扎（避坑 #12）。
- **自动压缩参数补 `retainRatio 0.16`**：报告里能解释「压完为什么还留着最近一段历史」。
- **诊断告警补 3 条新坑**：错误码不可靠（网关把超长/超时/限流统一包装）、网关 body 上限（请求越大越慢不一定是模型问题）、网关抖动后不落盘（可能留下损坏历史）。
- **压缩失败后的取证口径收紧**：原来会暗示「当前压力就是历史 overflow 的事实上限」；但插件只能数到失败次数，取不到那次失败请求的压力，现在明确要求从原始报错现场取数，拿不到就说「缺少事实上限证据」，不拿当前读数顶替。
- **`windowInflated` 与宿主自动压缩解耦**：`realWindows` 填的是「实测安全值」而不是线路上限，宿主自动压缩却按**声明窗口**算触发点。因此不再把 `windowInflated=true` 一概说成「自动压缩永不触发」：`windowSource=nominal` 时才是真·虚高；`windowSource=override` 时表示声明值超过实测安全值、宿主触发点会更晚，根治是把 profile 的 `contextWindow` 也改成实测值。决策技能同步加上「两把尺子」约束，不再用 pct 反推自动压缩是否失效。

### 明确不做（避免误导）

- **不判断 provider 是官方还是中转**。插件只看得到 `provider` 这个 profile 键名，看不到 baseURL；靠域名猜会误判，猜错比不猜更糟。因此 `windowSource=nominal` 只表示「未实测」，不表示「你在用中转」。
- **不自动从 session 事件反推线路上限**。宿主的 `compaction/*` 事件没有稳定的压力快照字段，自动反推会产出看起来精确、实则不可靠的窗口值。

### 变更

- `REAL_WINDOWS` 文案改为「标称值」并注明以 `window` + `windowSource` 为准。
- `windowFields()` 增加 `provider` / `realWindows` 参数并返回 `windowSource`、`routeKey`（旧的两参数调用行为不变）。
- `cordis.patch.yml` 补全 `handoffAt` 与 `realWindows` 默认值，并写明「同 id 整段替换 config」的注意事项。

### 测试

- 29 → 37：新增 realWindows 校验（键格式/正数/类型）、`routeKey` 与覆盖查找（含原型链键）、覆盖后 `windowSource`/`pct`/`windowInflated` 行为、未配置时退回标称、空路由、工具返回键与 schema 一致性、技能文本不得断言线路类型。

## [0.1.1] - 2026-10-27

### 修复（对外承诺与实际行为不符的三处）

- **主动提醒不再伪造 user 消息**。原实现借 `agent/pre-step` 把提醒塞进 `decision.messages`，声称「不落盘」；
  但宿主 `dsh-agent-loop` 的 `step()` 会把每条非 `runtime-context` 的消息 `session.append('user/message')` ——
  提醒其实会进会话历史、出现在对话里、并在之后每个请求重发，等于上下文插件给自己加压力。
  现在改挂宿主「运行时上下文」快照（`ctx.systemPrompt.context()`）：不新增 user 消息，压力回落自动消失，
  文案只按档位变化（不含精确百分比/token 数，避免快照每轮重写）。
- **`context_history.compactionError` 从恒为 0 改为真实计数**：原来数 `compaction/summary-error`，
  而宿主根本没有这个落盘事件（它只是内存里的 waterfall 钩子名）。改为数 `compaction/end` 且带 `error` 的事件。
- **有效窗口口径写进技能文本**：`window` 是 `min(声明, 真实上限)`，不再是「模型上下文上限」的模糊说法。

### 修复（其他）

- **窗口虚高检测补齐**：`context_pressure` 新增 `declaredWindow`、`realWindow`、`windowInflated` 三个字段。此前诊断技能让模型读这三个数，但工具根本没返回——现在按内置窗口表比对：声明 > 真实即 `windowInflated=true`。
- **`window` 改为有效窗口** = `min(declaredWindow, realWindow)`，`pct` 随之用这个数。声明虚高时 pct 不再永远偏低（自动压缩永不触发的根因）；声明偏小（合法限制）不会被放大。
- **型号查表改 `Object.hasOwn`**：型号来自 profile，写成 `toString`/`constructor` 会命中 `Object.prototype`，拿到函数后 `window` 变 `NaN`、`realWindow` 不是 JSON，返回值校验会直接失败。
- **`windowInflated=null` 的语义写全**：既包括「型号不在内置表」，也包括「本次会话还没有路由窗口记录」——都是「无法判断」，不能当 false。
- **无会话时不再假装 0 压力**：`context_pressure` / `context_history` 返回 `note: no session`，提示模型别把 0 读成「很空」。
- **主动提醒失败留日志**：读数异常仍降级为不注入，但会 `warn` 一条，不再让 `catch {}` 吞掉真 bug。
- **配置类型严格校验**：`enableXxx` 必须是 boolean、`remindAt` 必须是有限数字，写错直接报错；不再出现 `"false"` 被当成 true、`0` 被静默夹成 50。
- **斜杠命令补 `input.hint` 与取消检查**：`/handoff` 可带一句主题；请求已取消时返回 `error` 而不是继续 `agent.steer`。
- **阶梯与宿主阈值对齐说明**：新增 `AUTO_COMPACT` 常量与文档，写明 DSH `compaction-basic` 默认在约 80%（减 64K headroom）自动压缩，本插件的 85% 档在自动模式下通常轮不到人动手。
- **`context_history` 口径说明**：`peakTokens/lastTokens` 是输入侧 token（input+cacheRead+cacheWrite），与 `pressureTokens` 不可相减，已写进描述与文档。

### 变更

- 决策/诊断技能不再用 `ask_user_question` 给按钮（按钮无法真正执行 `/compact`），改为把 `/compact` 复制到剪贴板，用户粘贴执行；不能压时建议走交接。

### 新增

- **`context_history` 工具**：会话级趋势（峰值/最后一次输入侧 token）+ 压缩记录（尝试/成功/失败），用于复盘「压了几次、成没成、涨得多快」。由 `enablePressureTool` 一并注册（该开关现在管两个工具）。
- `context_pressure` 新增 `cacheHitRate`（0–1），从 DSH `tokenUsage` 投影读取，用于判断「该压还是该换会话」。
- 新增配置 `enableReminder`（默认 `false`）/ `remindAt`（默认 `85`，夹在 50–95）。
- 新增配置 `handoffAt`（默认 `92`，夹在 50–95）：压力过交接线时，提醒从「建议」升级为「自动执行交接」。
- 测试：10 → 29（窗口口径、原型链型号、非法 declared、配置类型、提醒求值/不抖动、handoffAt 夹取与强制交接文案、历史工具压缩分类与口径、无会话 note、服务缺失降级）。

### 健壮性

- `tokenMeter` 从硬依赖改为条件注入：缺失时只降级两个工具，技能照常注册。
- `systemPrompt` 缺失时只跳过主动提醒。
- `context_pressure` 增加兜底：无会话 / 读数失败时返回空值 + `note`，不再抛错。
- 斜杠命令 handler 增加会话判空。
- 新增插件配置 `enablePressureTool` / `enableCommands`；未知键直接报错。

## [0.1.0] - 2026-10-27

### 新增

- 三个技能：`context-handoff`（交接）、`context-decision`（该压了吗）、`context-diagnose`（上下文诊断）。
- `context_pressure` 工具：自包含读数，走 DSH 自带 `tokenMeter`，不依赖外部脚本。
- 三个斜杠命令：`/handoff`、`/pressure`、`/diagnose`。
- 决策/诊断支持「给建议 → 可点选项执行」（`ask_user_question`，无该工具时降级为文字选项）。
- 统一策略常量 `lib/policy.js`（阶梯/硬判据/三归因/真实窗口，单一来源）。
- 双语 metadata（`locale/en.json`、`locale/zh.json`）+ 图标（`icon.svg`）。
- `node --test` 单元测试（`test/policy.test.js`）。

### 变更

- 压缩摘要模型不再写死：改为文档化配置（走 DSH 原生 `compaction-basic.summarizationProvider/Model`）。
- 决策技能读数从「外部脚本」改为「`context_pressure` 工具」，消除对个人看板脚本的依赖。
