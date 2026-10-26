# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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

### 新增

- **`context_history` 工具**：会话级趋势（峰值/最后一次输入侧 token）+ 压缩记录（尝试/成功/失败），用于复盘「压了几次、成没成、涨得多快」。由 `enablePressureTool` 一并注册（该开关现在管两个工具）。
- `context_pressure` 新增 `cacheHitRate`（0–1），从 DSH `tokenUsage` 投影读取，用于判断「该压还是该换会话」。
- 新增配置 `enableReminder`（默认 `false`）/ `remindAt`（默认 `85`，夹在 50–95）。
- 测试：10 → 29（窗口口径、原型链型号、非法 declared、配置类型、提醒求值/不抖动、历史工具压缩分类与口径、无会话 note、服务缺失降级）。

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
