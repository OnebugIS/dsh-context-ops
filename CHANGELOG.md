# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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
