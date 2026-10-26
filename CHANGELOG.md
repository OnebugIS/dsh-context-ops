# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 主动提醒（可选）：每轮首步压力 ≥ `remindAt` 时，通过 `agent/pre-step` 注入一条不落盘、不触发新回合的 system-reminder；同会话同档位去重。
- `context_pressure` 新增 `cacheHitRate`（0–1），从 DSH `tokenUsage` 投影读取，用于判断「该压还是该换会话」。
- 新增配置 `enableReminder`（默认 `false`）/ `remindAt`（默认 `85`，夹在 50–95）。
- 新增 1 个测试：缓存命中率计算。

### 健壮性

- `tokenMeter` 从硬依赖改为条件注入：缺失时只降级压力工具，技能照常注册。
- `context_pressure` 增加兜底：无会话 / 读数失败时返回空值 + `note`，不再抛错。
- 斜杠命令 handler 增加会话判空。
- 新增插件配置 `enablePressureTool` / `enableCommands`；未知键直接报错。
- 新增 3 个测试：配置校验、无 agent、measure 抛错。

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
