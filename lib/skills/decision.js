/** 上下文决策技能：读数 → 套阶梯 → 给处方。 */
import { LADDER, HARD_RULE, FAILURE_ATTRIBUTION, AUTO_COMPACT } from '../policy.js'

export const DECISION_SKILL = {
  name: 'context-decision',
  description:
    '判断当前会话该压缩还是该交班：先调 context_pressure 工具拿真实数字，再按阶梯给一句处方。触发词：上下文管理、该压了吗、要不要交班、上下文怎么办、压力多少、还有多少余量。',
  source: 'runtime:dsh-context-ops',
  content: `# 上下文决策（context-decision）

目的：一句话判断「现在该压缩、该交班、还是照常用」。

## 第一步：拿数（不要猜）
调 context_pressure 工具，取三个数：pressureTokens（请求体总 token）、**有效窗口** window（= min(声明窗口, 该型号真实上限)）、占用% pct。

## 第二步：套阶梯（经验分档，不是官方阈值）
${LADDER}

## 第三步：硬判据（唯一必须满足）
${HARD_RULE}
不满足 → 别压，直接走交接。

## 压缩失败三归因
${FAILURE_ATTRIBUTION}

## 宿主自己的自动压缩阈值
${AUTO_COMPACT}

## 输出与执行
1. 给一句处方：做什么 + 为什么 + 依据哪个数（数字带中文含义：有效窗口 window、压力 pressureTokens、占用 pct）。不要长篇解释、不要复制整份手册。
   如果 pct 已经超过宿主自动压缩触发点（默认约 80%），要顺带说一句「宿主本该已经自动压过」——这通常意味着自动压缩被关掉/阈值被改过，或者窗口声明有问题（看 windowInflated）。
2. 「能压 = 能」→ 建议压缩，并用 bash 把 /compact 复制到剪贴板（macOS 执行 printf '/compact' | pbcopy；非 macOS 就只提示「请发 /compact」）；「能压 = 不能」→ 建议走交接（触发 context-handoff）。
`
}
