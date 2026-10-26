# dsh-context-ops

一个 DSH 插件，把「上下文管理」的三个动作封装成一个包。

> A DeepSeek Harness (dsh) plugin that bundles three context-management actions: stronger-model compaction summaries, a handoff skill, and a context-decision skill.

## 三个动作

| 动作 | 实现 | 说明 |
|---|---|---|
| 压缩摘要走强模型 | `cordis.patch.yml` 覆盖 `compaction-basic.summarizationProvider/Model` | 把 `/compact` 的摘要路由到强模型，减少「摘要丢约束 / 压不动」 |
| 交接技能 | `lib/skills/handoff.js` | 产出 5 行 brief 到 `CHECKPOINT.md`，替代重读旧聊天 |
| 上下文决策技能 | `lib/skills/decision.js` | 读数 → 套阶梯 → 给一句处方 |

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
- 发「该压了吗」「上下文怎么办」→ 先读看板数字，再给处方
- `/compact` → 摘要改由强模型出

> 说明：「上下文决策」技能会读一个外部看板脚本 `ctx-report.mjs` 拿真实压力数字；该脚本路径在本机 Hermes 目录下，如需复用请自行准备同款读数脚本，否则该技能退化为按经验判断。

## 依赖与要求

- 无第三方运行时依赖，纯 ESM
- `engines.node >= 20`
- 基于 DSH 的 `ctx.skills.register` 技能注册机制

## 目录

```
lib/index.js            入口，注册两个技能
lib/skills/handoff.js   交接技能
lib/skills/decision.js  上下文决策技能
cordis.patch.yml        自注册入口 + 摘要模型覆盖
package.json            无依赖，dsh.bundle 声明
```

## License

[MIT](LICENSE)
