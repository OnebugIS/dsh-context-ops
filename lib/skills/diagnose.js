/** 上下文压缩诊断技能：一次体检，逐层核对，给完整诊断报告。 */
import { LADDER, HARD_RULE, FAILURE_ATTRIBUTION, REAL_WINDOWS, AUTO_COMPACT } from '../policy.js'

export const DIAGNOSE_SKILL = {
  name: 'context-diagnose',
  description:
    '对当前会话做一次上下文压缩体检：调 context_pressure 拿数，逐层核对（模型窗口/占用落档/能否压缩/是否该交班），给一份诊断报告。触发词：上下文诊断、诊断一下、上下文体检、体检、ctx-check、帮我看看上下文。',
  source: 'runtime:dsh-context-ops',
  content: `# 上下文压缩诊断（context-diagnose）

目的：一次性体检当前会话，给出「现在该做什么」的完整诊断，不止一句处方。

## 第一步：拿数（不要猜）
调 context_pressure 取 pressureTokens、window、pct、provider、model、declaredWindow、realWindow、windowInflated、cacheHitRate；再调 context_history 取 peakTokens、lastTokens、compactionCount、compactionSuccess、compactionError（看趋势与复盘）。

## 第二步：逐层核对
1. **数据口径**：用 pressureTokens ÷ window；不用 inputTokens，也不信界面那个 projectedTokens（偏低）。
2. **模型设置**：当前 model + **有效窗口** window（已按 min(declaredWindow, realWindow) 校正，pct 也用这个数）。
   核对 windowInflated —— true 表示声明窗口虚高（自动压缩永不触发，需改 profile）；
   false 表示没虚高；**null = 型号不在内置窗口表里，或本次会话还没有路由窗口记录**（都属「无法判断」，别当成 false 安全）。
3. **落档**：按 pct 查阶梯。
4. **硬判据**：${HARD_RULE}。
5. **交班触发**：命中任一即交班（见下）。

## 阶梯（经验分档，非官方阈值）
${LADDER}

## 宿主自己的自动压缩阈值（决定「轮不轮得到你动手」）
${AUTO_COMPACT}

> 报告里必须把这两把尺子分开说：本插件的阶梯是建议，宿主在约 80% 就自己压。
> 用户看到「85%，还没到交接档」时，很可能压缩早就自动发生过了。

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
     - 有效窗口 window：当前实际可用的上下文上限（= min(声明窗口, 该型号真实上限)）
     - pressureTokens：上次请求体实际发出的 token 数（上下文压力）
     - 占用 pct：pressureTokens ÷ window × 100（占用百分比）
     - 缓存命中 cacheHitRate：全会话累计；偏低说明上下文一直被改写（或该 provider 不支持前缀缓存）
     - 趋势：峰值 peakTokens、最后 lastTokens（**输入侧 token，口径比 pressureTokens 小**，只用来比涨势，别和 pressureTokens 相减）；压缩历史 compactionCount 次、成功 compactionSuccess、失败 compactionError（失败即 compaction/end 带 error，通常看后端三归因）
   - **落档**：处于哪一档
   - **能压吗（技术判断）**：能 ⇔ pressureTokens < window × 0.95；说「能」= 现在点压缩会成功，说「不能」= 压了会失败（按三归因走）
   - **该压吗（建议）**：按落档判断；能压 ≠ 该压——能压只是「技术上压得动」，该不该现在压看落档
   - **告警**：windowInflated=true 就写「窗口虚高：声明 X、真实 Y，自动压缩永不触发，请改 profile」；其余坑（换模型立即压 / 界面%偏低 / 输出拉满 / 自动压缩阈值被改过 等）命中就写，没命中写无
2. 「能压 = 能」→ 紧接着给一个 [压缩] 按钮（别给「先不动」），用户点它就去 /compact。
3. 「能压 = 不能」→ 给一个 [写交接表] 按钮，用户点它就走交接。
4. 没有 ask_user_question 工具时，退化成文字：能压就问「要我压缩吗？（回『压』或『不用』）」；不能压就问「要我写交接表吗？」。
5. 用户点按钮 / 回「压缩」才动手（/compact 或写交接）；不点、不回应就不动，别自作主张。
`
}
