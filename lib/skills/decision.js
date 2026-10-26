/** 上下文决策技能：读数 → 套阶梯 → 给处方。 */
import { LADDER, HARD_RULE, FAILURE_ATTRIBUTION } from '../policy.js'

export const DECISION_SKILL = {
  name: 'context-decision',
  description:
    '判断当前会话该压缩还是该交班：先调 context_pressure 工具拿真实数字，再按阶梯给一句处方。触发词：上下文管理、该压了吗、要不要交班、上下文怎么办、压力多少、还有多少余量。',
  source: 'runtime:dsh-context-ops',
  content: `# 上下文决策（context-decision）

目的：一句话判断「现在该压缩、该交班、还是照常用」。

## 第一步：拿数（不要猜）
调 context_pressure 工具，取三个数：pressureTokens（请求体总 token）、真实窗口 window、占用% pct。

## 第二步：套阶梯（经验分档，不是官方阈值）
${LADDER}

## 第三步：硬判据（唯一必须满足）
${HARD_RULE}
不满足 → 别压，直接走交接。

## 压缩失败三归因
${FAILURE_ATTRIBUTION}

## 输出与执行
1. 给一句处方：做什么 + 为什么 + 依据哪个数（数字带中文含义：真实窗口 window、压力 pressureTokens、占用 pct）。不要长篇解释、不要复制整份手册。
2. 「能压」是技术判断（pressureTokens < window × 0.95），「该压」是建议（按落档）；两者分开，只有「该压 / 该交接」才给按钮。
3. 该压 / 该交接时，用 ask_user_question 工具给选项：[立刻执行] [先不动]；用户点「立刻执行」才动手。
4. 没有 ask_user_question 工具时，退化成文字选项：回复末尾列 [1] 立刻执行  [2] 先不动，等用户回数字再动。
5. 正常（照常用）就只给结论，不给按钮。
`
}
