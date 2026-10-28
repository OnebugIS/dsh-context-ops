/** 上下文压缩诊断技能：一次体检，逐层核对，给完整诊断报告。 */
import { LADDER, HARD_RULE, FAILURE_ATTRIBUTION, REAL_WINDOWS, AUTO_COMPACT, WINDOW_EVIDENCE } from '../policy.js'

export const DIAGNOSE_SKILL = {
  name: 'context-diagnose',
  description:
    '对当前会话做一次上下文压缩体检：调 context_pressure 拿数，逐层核对（模型窗口/占用落档/能否压缩/是否该交班），给一份诊断报告。触发词：上下文诊断、诊断一下、上下文体检、体检、ctx-check、帮我看看上下文。',
  source: 'runtime:dsh-context-ops',
  content: `# 上下文压缩诊断（context-diagnose）

目的：一次性体检当前会话，给出「现在该做什么」的完整诊断，不止一句处方。

## 第一步：拿数（不要猜）
调 context_pressure 取 pressureTokens、window、pct、provider、model、declaredWindow、realWindow、windowSource、routeKey、windowInflated、cacheHitRate；再调 context_history 取 peakTokens、lastTokens、compactionCount、compactionSuccess、compactionError（看趋势与复盘）。

## 第二步：逐层核对
1. **数据口径**：用 pressureTokens ÷ window；不用 inputTokens，也不信界面那个 projectedTokens（偏低）。
2. **模型设置**：当前 model + **有效窗口** window（已按 min(declaredWindow, realWindow) 校正，pct 也用这个数）。
   核对 windowInflated 时**必须同时看 windowSource**，两种情况含义不同：
   - windowSource=nominal 且 inflated=true：声明窗口高于型号标称值 → 宿主仍按声明算自动压缩触发点，可能永远压不到，属真·虚高。
   - windowSource=override 且 inflated=true：声明窗口高于你在该线路的**实测安全值** → pct 按实测算没问题，但宿主触发点仍按声明算，会比实测墙更晚，所以**根治是把 profile 的 contextWindow 也改成实测值**，光填 realWindows 只修正了报告。
   - false 表示没虚高；**null = 型号不在标称表里、或本次会话还没有路由窗口记录**（都属「无法判断」，别当成 false 安全）。
3. **落档**：按 pct 查阶梯。
4. **硬判据**：${HARD_RULE}。
5. **交班触发**：命中任一即交班（见下）。

## 阶梯（经验分档，非官方阈值）
${LADDER}

## 宿主自己的自动压缩阈值（决定「轮不轮得到你动手」）
${AUTO_COMPACT}

> 报告里必须把这两把尺子分开说：本插件的阶梯是建议，宿主在约 80% 就自己压。
> 用户看到「85%，还没到交接档」时，很可能压缩早就自动发生过了。

## 窗口证据来源（windowSource —— 只讲依据，不猜线路）
${WINDOW_EVIDENCE}

> **不要推断 provider 是官方还是中转**：插件看不到线路类型，provider 只是 profile 里的键名。
> 只能说「这个 provider/model 的窗口来自标称值 / 尚未实测」，不能说「你在用中转」。

## 常见标称窗口（参考；以 context_pressure 返回的 window 与 windowSource 为准）
${REAL_WINDOWS}

## 压缩失败三归因
${FAILURE_ATTRIBUTION}

## 换模型再压的正确姿势
换模型 → 先跑一轮普通对话（让会话真正切过去）→ 再 /compact。立即压缩仍走旧模型。

## 交班硬触发（任一即交班）
1. pressureTokens ≥ window × 0.95
2. /compact 报 overflow / idle timeout
3. 历史损坏（tool_use ids without tool_result，连普通消息都报错）
4. 内容审核锁死（\`400 Content Exists Risk\`）—— 同会话里继续挣扎不会恢复
5. 每轮 400 死循环，重启后全量重放仍无法恢复

## 输出与执行
1. 先给**诊断报告**（简洁，数字都要带中文含义，别只丢数字）：
   - **现状**：
     - 模型 model（provider）：当前用什么模型、走哪条通道
     - 有效窗口 window：当前实际可用的上下文上限（= min(声明窗口, 真实窗口)），**并注明 windowSource**（override 实测配置 / nominal 内置标称 / declared 仅声明值 / unknown）
     - pressureTokens：上次请求体实际发出的 token 数（上下文压力）
     - 占用 pct：pressureTokens ÷ window × 100（占用百分比）
     - 缓存命中 cacheHitRate：全会话累计；偏低说明上下文一直被改写（或该 provider 不支持前缀缓存）
     - 趋势：峰值 peakTokens、最后 lastTokens（**输入侧 token，口径比 pressureTokens 小**，只用来比涨势，别和 pressureTokens 相减）；压缩历史 compactionCount 次、成功 compactionSuccess、失败 compactionError（失败即 compaction/end 带 error，通常看后端三归因）
   - **落档**：处于哪一档
   - **能压吗（技术判断）**：能 ⇔ pressureTokens < window × 0.95；说「能」= 现在点压缩会成功，说「不能」= 压了会失败（按三归因走）
   - **该压吗（建议）**：按落档判断；能压 ≠ 该压——能压只是「技术上压得动」，该不该现在压看落档
   - **告警**（只写命中的，没命中就写「无」）：
     - windowInflated=true 且 windowSource=nominal → 「声明窗口 X 高于型号标称值 Y：宿主按声明算触发点，可能永远压不到，请改 profile」
     - windowInflated=true 且 windowSource=override → 「声明窗口 X 高于你在这条线路的实测安全值 Y：pct 已按 Y 算，但**宿主自动压缩仍按 X 算**，触发点会比实测墙更晚；根治是把 profile 的 contextWindow 改成 Y」
     - windowSource ≠ override → 按来源分别说，别一律说「未实测」：
        windowSource=nominal → 「窗口由型号标称值限制（Y），未必适配当前线路；建议按手册 §1.6 实测后填 realWindows」
        windowSource=declared → 「窗口由 profile 声明值限制（Y）；插件无法判断该值的依据。若你已实测，请把它填进 realWindows 固化证据；若没测，建议测一次」
        windowSource=unknown → 「没有可用窗口，无法判断能否压缩，请先确认 provider/model 与 contextWindow」
     - 换模型后立即压（仍走旧模型）/ 界面百分比偏低（那是 projectedTokens）/ 输出上限拉满（会截断）/ 自动压缩阈值被改过
     - 错误码不可靠：中转/网关常把超长、超时、限流统一包装成一句 upstream_unavailable，**别用错误码判断上下文边界**
     - 请求越大越慢越贵可能是**网关 body 上限**在掐，不一定是模型问题
     - 网关抖动后不落盘就继续跑，可能留下损坏历史（对应硬触发第 3 条）
2. **压不动时顺手留证据**：只要 compactionError > 0，就提示——
   「历史里有压缩失败；插件当前只能知道失败次数，不能从已公开的 session 事件可靠取出那次失败请求的压力值。请从原始报错/诊断现场取得当时 pressureTokens，再把该值按 routeKey 记进 profile 的 realWindows。」
   如果本次当前读数已经达到「pressureTokens ≥ window × 0.95」，再补充「当前读数已越过硬线」；不要把当前读数冒充历史 overflow 的事实上限。
   如果用户提供了原始 overflow 时的请求体数值，才可建议把该路由的实测安全值写进 realWindows；没有数就明确说「缺少事实上限证据」。
3. 「能压 = 能」→ 建议压缩，并**用 bash 把 /compact 复制到剪贴板**（macOS 执行 printf '/compact' | pbcopy；非 macOS 就只提示「请发 /compact」），然后告诉用户「已把 /compact 复制到剪贴板，粘贴到输入框执行即可」。
4. 「能压 = 不能」→ 建议走交接（触发 context-handoff）。
`
}
