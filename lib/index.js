/**
 * dsh-context-ops —— 上下文运维插件（自研）
 * 一个包做三件事：
 *   1) 通过 cordis.patch.yml 把 /compact 的摘要路由到强模型
 *   2) 注册「交接」技能（五行 brief，续接/收尾）
 *   3) 注册「上下文决策」技能（读数 → 套阶梯 → 给处方）
 * 另附两个斜杠命令（可选，无 commands 服务时只注册技能）：
 *   /handoff   交接（等价「交接」触发词）
 *   /pressure  该压了吗（等价「该压了吗」触发词）
 */
import { randomUUID } from 'node:crypto'
import { HANDOFF_SKILL } from './skills/handoff.js'
import { DECISION_SKILL } from './skills/decision.js'

export const name = 'context-ops'
export const inject = ['skills']

/** 手拼一条 user 消息，等价 @deepseek-ai/dsh-llm 的 createUserMessage，避免引依赖。 */
function userMessage(text) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
    id: randomUUID(),
  }
}

export function apply(ctx) {
  ctx.skills.register(HANDOFF_SKILL)
  ctx.skills.register(DECISION_SKILL)

  // 斜杠命令：点命令 = 注入一条用户消息，让模型加载对应技能执行（照 /plan 模式）
  ctx.inject(['commands'], (cctx) => {
    cctx.commands.register({
      name: 'handoff',
      description: '交接：产出 5 行交接表（目标/现状/下一步/未决/证据）到 CHECKPOINT.md',
      handler: ({ agent, rawInput }) => {
        const extra = rawInput.trim()
        agent.steer(userMessage(extra ? `交接：${extra}` : '交接'))
        return { kind: 'success', text: '已触发交接流程（context-handoff）。' }
      },
    })
    cctx.commands.register({
      name: 'pressure',
      description: '该压了吗：读 ctx-report 判断当前会话该压缩、该交班、还是照常用',
      handler: ({ agent }) => {
        agent.steer(userMessage('该压了吗'))
        return { kind: 'success', text: '已触发上下文决策（context-decision）。' }
      },
    })
  })

  ctx.logger?.info?.('context-ops: 交接技能 + 上下文决策技能 + /handoff /pressure 已注册')
}
