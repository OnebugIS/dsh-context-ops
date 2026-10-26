/** 上下文决策技能：读数 → 套阶梯 → 给处方。 */
export const DECISION_SKILL = {
  name: 'context-decision',
  description:
    '判断当前会话该压缩还是该交班：先读看板/ctx-report 拿真实数字，再按阶梯给一句处方。触发词：上下文管理、该压了吗、要不要交班、上下文怎么办、压力多少、还有多少余量。',
  source: 'runtime:dsh-context-ops',
  content: `# 上下文决策（context-decision）

目的：一句话判断「现在该压缩、该交班、还是照常用」。

## 第一步：拿数（不要猜）
跑：node "<Hermes>/95：会话监控/ctx-report.mjs" --json
取该会话三个数：上次请求体 pressureTokens、真实窗口 win、占用% pct。

## 第二步：套阶梯（经验分档，不是官方阈值）
| 占用 | 处方 |
| <50% | 正常，照常用 |
| 50–70% | 写小结，为压缩备料 |
| 70–85% | 立刻 /compact（成功率最高区间） |
| 85–100% | 停止加活，写交接，准备交班 |
| ≥100% | 核口径；压缩失败就交班 |

## 第三步：硬判据（唯一必须满足）
能压缩 ⇔ pressureTokens < 真实窗口 × 0.95
不满足 → 别压，直接走交接。

## 压缩失败三归因
- context overflow → 换大窗口模型再压，或交班
- stream idle timeout → 别重试，直接交班
- summary is not smaller → 已到极限，忽略

## 输出格式
给一句处方：做什么 + 为什么 + 依据哪个数。不要长篇解释、不要复制整份手册。
`
}
