# dsh-context-ops

一个 DSH 插件，把「上下文管理」的常用动作封装成一个包：交接技能、上下文决策技能、压力读数工具、斜杠命令。

> A DeepSeek Harness (dsh) plugin bundling context-management actions: a handoff skill, a context-decision skill, a self-contained pressure tool, and slash commands.

## 能做什么

| 能力 | 实现 | 说明 |
|---|---|---|
| 交接技能 | `lib/skills/handoff.js` | 产出 5 行 brief 到 `CHECKPOINT.md`，替代重读旧聊天 |
| 上下文决策技能 | `lib/skills/decision.js` | 读数 → 套阶梯 → 给一句处方 |
| 上下文诊断技能 | `lib/skills/diagnose.js` | 一次体检，逐层核对，给完整诊断报告 |
| 压力读数工具 | `context_pressure`（`lib/index.js` 内注册） | 自包含读数，数据来自 DSH 自带 `tokenMeter`，不依赖任何外部脚本 |
| 斜杠命令 | `/handoff`、`/pressure`、`/diagnose`（`lib/index.js` 内注册） | 显式触发对应技能 |
| 压缩摘要走强模型 | 文档化（见下） | 走 DSH 原生 `compaction-basic` 字段，本插件不写死任何账号/模型 |

### 压缩摘要走强模型（可选项）

本插件**不写死** provider/model。如需把 `/compact` 的摘要路由到指定模型，在你自己的 profile `cordis.patch.yml` 里给 `compaction-basic` 配（DSH 原生字段）：

```yaml
- id: compaction-basic
  config:
    summarizationProvider: deepseek-account   # 换成你自己的 provider
    summarizationModel: deepseek-v4-pro       # 换成你自己的 model
```

两个字段要么都空（默认 = 用当前会话模型），要么都填，否则 `compaction-basic` 会拒载。

## 安装

```sh
dsh plugin --profile <你的 profile> add dsh-context-ops
```

本地安装：

```sh
dsh plugin --profile <你的 profile> add "file:/绝对路径/dsh-context-ops"
```

装完**重启 DSH** 生效。

## 使用

- 发「交接」「收尾」→ 进入 5 行 brief 流程
- 发「该压了吗」「上下文怎么办」→ 调 `context_pressure` 拿数，再给处方
- 发「上下文诊断」「体检」→ 一次体检，逐层核对，给完整诊断报告
- `/handoff`、`/pressure`、`/diagnose` → 与上面对应，显式触发

## 健壮性 / 适配性

- **无外部脚本依赖**：决策读数的 `context_pressure` 工具读 DSH 自带 `tokenMeter`，任何 DSH 装上就能用。
- **不写死账号/模型**：压缩摘要模型走文档化配置（见上），不绑定某人的 provider/model。
- **可选依赖降级**：`commands` 服务缺失时只注册技能+工具，不崩。

## 依赖与要求

- 无第三方运行时依赖，纯 ESM（仅用 `node:crypto`）
- `engines.node >= 20`
- 基于 DSH 的 `ctx.skills.register`、`ctx.tools.register`、`ctx.commands.register` 机制

## 目录

```
lib/index.js            入口：注册技能 + context_pressure 工具 + 三个斜杠命令
lib/policy.js           统一策略常量（阶梯/硬判据/三归因/真实窗口）
lib/skills/handoff.js   交接技能
lib/skills/decision.js  上下文决策技能
lib/skills/diagnose.js  上下文诊断技能
cordis.patch.yml        自注册入口（含压缩摘要模型配置示例）
package.json            无依赖，dsh.bundle 声明
```

## 测试与发布

- 测试：`npm test`（基于 node 内置 `node --test`，无需装额外依赖）
- 发布到 npm（本地目录安装无需此步）：

```sh
npm publish
```

## License

[MIT](LICENSE)
