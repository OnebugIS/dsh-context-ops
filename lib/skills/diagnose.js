/** 上下文压缩诊断技能：一次体检，逐层核对，给完整诊断报告。 */
import { LADDER, HARD_RULE, FAILURE_ATTRIBUTION, REAL_WINDOWS } from '../policy.js'

export const DIAGNOSE_SKILL = {
  name: 'context-diagnose',
  description:
    '对当前会话做一次上下文压缩体检：调 context_pressure 拿数，逐层核对（模型窗口/占用落档/能否压缩/是否该交班），给一份诊断报告。触发词：上下文诊断、诊断一下、上下文体检、体检、ctx-check、帮我看看上下文。',
  source: 'runtime:dsh-context-ops',
  content: `# 上下文压缩诊断（context-diagnose）

目的：一次性体检当前会话，给出「现在该做什么」的完整诊断，不止一句处方。

## 第一步：拿数（不要猜）
调 context_pressure 工具，取 pressureTokens、window、pct、provider、model。

## 第二步：逐层核对
1. **数据口径**：用 pressureTokens ÷ window；不用 inputTokens，也不信界面那个 projectedTokens（偏低）。
2. **模型设置**：当前 model + window；核对 window 是否是真实窗口（见下方参考表）。
3. **落档**：按 pct 查阶梯。
4. **硬判据**：${HARD_RULE}。
5. **交班触发**：命中任一即交班（见下）。

## 阶梯（经验分档，非官方阈值）
${LADDER}

## 常见真实窗口（参考；以 context_pressure 返回的 window 为准）
${REAL_WINDOWS}

## 压缩失败三归因
${FAILURE_ATTRIBUTION}

## 换模型再压的正确姿势
换模型 → 先跑一轮普通对话（让会话真正切过去）→ 再 /compact。立即压缩仍走旧模型。

## 交班硬触发（任一即交班）
1. pressureTokens ≥ window × 0.95
2. /compact 报 overflow / idle timeout
3. 历史损坏（tool_use ids without tool_result，连普通消息都报错）
4. 每轮 400 死循环，重启后全量重放仍无法恢复

## 输出与执行（先给建议，再给可点选项）
1. 先给**诊断报告**（简洁，数字都要带中文含义，别只丢数字）：
   - **现状**：
     - 模型 model（provider）：当前用什么模型、走哪条通道
     - 真实窗口 window：该模型上下文上限（token 数）
     - pressureTokens：上次请求体实际发出的 token 数（上下文压力）
     - 占用 pct：pressureTokens ÷ window × 100（占用百分比）
   - **落档**：处于哪一档
   - **能压吗（技术判断）**：能 ⇔ pressureTokens < window × 0.95；说「能」= 现在点压缩会成功，说「不能」= 压了会失败（按三归因走）
   - **该压吗（建议）**：按落档判断；能压 ≠ 该压——能压只是「技术上压得动」，该不该现在压看落档
   - **告警**：命中哪条坑（窗口虚高 / 换模型立即压 / 界面%偏低 / 输出拉满 等，没命中写无）
2. 只有「该压 / 该交接」时才给按钮；「能压但不用现在压」就只给结论、不给按钮。
3. 该压 / 该交接时，用 ask_user_question 工具给选项让用户点选：
   - 该压缩 → 选项：[立刻压缩] [先不动]
   - 该交接 → 选项：[写交接表] [先不动]
4. 没有 ask_user_question 工具时，退化成文字选项：回复末尾列 [1] 立刻压缩  [2] 写交接表  [3] 先不动，等用户回数字再动。
5. 用户点「执行」类选项才动手（/compact 或写交接）；点「先不动」或没回应就不动，别自作主张。
`
}
