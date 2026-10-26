/**
 * dsh-context-ops —— 上下文运维插件（自研）
 * 一个包做：
 *   1) 注册「交接」技能（五行 brief，续接/收尾）
 *   2) 注册「上下文决策」技能（读数 → 套阶梯 → 给处方）
 *   3) 注册「上下文诊断」技能（一次体检，逐层核对，给诊断报告）
 *   4) 注册 context_pressure 工具（自包含读数，不依赖外部脚本）
 *   5) 三个斜杠命令 /handoff、/pressure、/diagnose（可选，无 commands 服务时跳过）
 * 压缩摘要走强模型 = 在 DSH 原生 compaction-basic 配 summarizationProvider/Model（见 README），
 * 本插件不写死任何账号/模型。
 */
import { randomUUID } from 'node:crypto'
import { HANDOFF_SKILL } from './skills/handoff.js'
import { DECISION_SKILL } from './skills/decision.js'
import { DIAGNOSE_SKILL } from './skills/diagnose.js'

export const name = 'context-ops'
export const inject = ['skills', 'tools', 'tokenMeter']

/** 手拼一条 user 消息，等价 @deepseek-ai/dsh-llm 的 createUserMessage，避免引依赖。 */
function userMessage(text) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
    id: randomUUID(),
  }
}

/** context_pressure 工具：读当前会话压力，任何 DSH 都能用（数据来自 tokenMeter，不依赖外部脚本）。 */
export function pressureTool(ctx) {
  return {
    name: 'context_pressure',
    description:
      '读取当前会话的上下文压力：pressureTokens（请求体总 token）、真实窗口 window、占用百分比 pct、当前 provider/model。判断该压缩还是该交班时先调它拿数。拿不到窗口时 window/pct 为 null。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pressureTokens: { type: 'number', description: '请求体总 token（压力）' },
          surfaceTokens: { type: 'number', description: '对话面 token' },
          window: { oneOf: [{ type: 'number' }, { type: 'null' }], description: '真实上下文窗口；未知时为 null' },
          pct: { oneOf: [{ type: 'number' }, { type: 'null' }], description: '占用百分比 = pressureTokens / window * 100；窗口未知时为 null' },
          provider: { type: 'string', description: '当前路由 provider；未知为空串' },
          model: { type: 'string', description: '当前路由 model；未知为空串' },
        },
        required: ['pressureTokens', 'surfaceTokens'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (_args, exec) => {
      const agent = exec.agent
      if (!agent) throw new Error('context_pressure 需要调用 agent（无会话）')
      const session = agent.session
      const m = ctx.tokenMeter.measure(session)
      const rc = session.requestContext()
      const window = rc?.contextWindow ?? null
      const pressureTokens = m.totalTokens
      const surfaceTokens = m.surfaceTokens
      const pct = window != null && window > 0 ? Math.round((pressureTokens / window) * 1000) / 10 : null
      return {
        pressureTokens,
        surfaceTokens,
        window,
        pct,
        provider: rc?.provider ?? '',
        model: rc?.model ?? '',
      }
    },
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const dispose = [
      ctx.skills.register(HANDOFF_SKILL),
      ctx.skills.register(DECISION_SKILL),
      ctx.skills.register(DIAGNOSE_SKILL),
      ctx.tools.register(pressureTool(ctx)),
    ]
    return () => dispose.forEach((d) => d())
  }, 'context-ops: skills + tool lifecycle')

  // 斜杠命令：点命令 = 注入一条用户消息，让模型加载对应技能执行（照 /plan 模式）
  ctx.inject(['commands'], (cctx) => {
    cctx.effect(() => {
      const dispose = [
        cctx.commands.register({
          name: 'handoff',
          description: '交接：产出 5 行交接表（目标/现状/下一步/未决/证据）到 CHECKPOINT.md',
          handler: ({ agent, rawInput }) => {
            const extra = rawInput.trim()
            agent.steer(userMessage(extra ? `交接：${extra}` : '交接'))
            return { kind: 'success', text: '已触发交接流程（context-handoff）。' }
          },
        }),
        cctx.commands.register({
          name: 'pressure',
          description: '该压了吗：调 context_pressure 判断当前会话该压缩、该交班、还是照常用',
          handler: ({ agent }) => {
            agent.steer(userMessage('该压了吗'))
            return { kind: 'success', text: '已触发上下文决策（context-decision）。' }
          },
        }),
        cctx.commands.register({
          name: 'diagnose',
          description: '上下文压缩诊断：一次性体检（模型/窗口/压力/落档/能压吗/处方）',
          handler: ({ agent }) => {
            agent.steer(userMessage('上下文诊断'))
            return { kind: 'success', text: '已触发上下文诊断（context-diagnose）。' }
          },
        }),
      ]
      return () => dispose.forEach((d) => d())
    }, 'context-ops: commands lifecycle')
  })

  ctx.logger?.info?.('context-ops: 技能 + context_pressure 工具 + /handoff /pressure /diagnose 已注册')
}
