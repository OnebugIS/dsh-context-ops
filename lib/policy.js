/** 上下文管理统一策略 —— 决策/诊断技能共用的常量，改一处全生效。 */
/** 依据：《上下文管理：分层操作手册》§3 运行阈值（经验分档，非官方阈值） */

export const LADDER = `| pct | 动作 |
| <30% | 正常推进，给准材料与范围 |
| 30–50% | 长任务主动处理：落盘成果，空闲点提前 /compact |
| 50–70% | 子任务结束留小结；新增独立需求另开会话 |
| 70–85% | 保全成果、缩小输入；可试压，失败按三归因分流 |
| 85–100% | 避免新增大请求，准备简短交接 |
| ≥100% | 核口径与原始报错，不反复重发；压缩失败转新会话 |`

/** 压缩硬判据（§4.1） */
export const HARD_RULE = '能压缩 ⇔ pressureTokens < window × 0.95'

/** 压缩失败三归因（§4.3） */
export const FAILURE_ATTRIBUTION = `- context overflow → 换大窗口模型再压，或交班
- stream idle timeout → 别重试，直接交班
- summary is not smaller → 已到极限，忽略；要降只能新会话`

/** 常见真实窗口（§1.2；参考，以 context_pressure 返回的 window 为准） */
export const REAL_WINDOWS = `- glm-5.3 / glm-5.3-flash：131,072
- kimi-k2.7-code / qwen3.8-max：262,144
- deepseek-v4-pro / deepseek-flash（官方账号）：1,048,576`
