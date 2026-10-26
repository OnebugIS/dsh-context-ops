/**
 * dsh-context-ops —— 上下文运维插件（自研）
 * 一个包做：
 *   1) 注册「交接」技能（五行 brief，续接/收尾）
 *   2) 注册「上下文决策」技能（读数 → 套阶梯 → 给处方）
 *   3) 注册「上下文诊断」技能（一次体检，逐层核对，给诊断报告）
 *   4) 注册 context_pressure 工具（自包含读数，不依赖外部脚本）
 *   5) 三个斜杠命令 /handoff、/pressure、/diagnose（可选，无 commands 服务时跳过）
 *   6) 可选主动提醒：每轮首步压力超阈值时，注入一条不落盘的 system-reminder
 * 压缩摘要走强模型 = 在 DSH 原生 compaction-basic 配 summarizationProvider/Model（见 README），
 * 本插件不写死任何账号/模型。
 *
 * 健壮性约定：
 *   - tokenMeter 不在 inject 里：它是独立插件（dsh-base 提供），缺失时只降级掉压力工具，技能照常注册。
 *   - 工具 execute 不抛错：读写失败时返回空值 + note，避免把一次读数故障变成对话故障。
 *   - config 严格校验：未知键直接报错，不静默忽略。
 *   - 主动提醒默认关闭；提醒走 agent/pre-step，不落盘、不触发新回合。
 */
import { randomUUID } from 'node:crypto'
import { HANDOFF_SKILL } from './skills/handoff.js'
import { DECISION_SKILL } from './skills/decision.js'
import { DIAGNOSE_SKILL } from './skills/diagnose.js'

export const name = 'context-ops'
// 只硬依赖技能与工具两个服务；tokenMeter / commands / sessionProjections 都走可选注入。
export const inject = ['skills', 'tools']

/** 允许的配置键；未知键直接报错（等价 schema 的严格校验，但不引 schemastery）。 */
const CONFIG_KEYS = new Set(['enablePressureTool', 'enableCommands', 'enableReminder', 'remindAt'])

/**
 * 解析并校验配置，未知键报错。
 * @param {object} config 插件配置（cordis.patch.yml 的 config）
 * @returns {{ enablePressureTool: boolean, enableCommands: boolean, enableReminder: boolean, remindAt: number }}
 */
export function resolveConfig(config) {
  const input = config ?? {}
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`context-ops: unknown config key "${key}"`)
  }
  const remindAt = typeof input.remindAt === 'number' && Number.isFinite(input.remindAt) ? input.remindAt : 85
  return {
    enablePressureTool: input.enablePressureTool !== false,
    enableCommands: input.enableCommands !== false,
    enableReminder: input.enableReminder === true,
    remindAt: Math.min(95, Math.max(50, Math.round(remindAt))),
  }
}

/** 手拼一条 user 消息，等价 @deepseek-ai/dsh-llm 的 createUserMessage，避免引依赖。 */
function userMessage(text, kind = 'user') {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
    id: randomUUID(),
  }
}

/** 读数不可用时的空值（schema 允许 window/pct/cacheHitRate 为 null）。 */
const EMPTY_PRESSURE = {
  pressureTokens: 0,
  surfaceTokens: 0,
  window: null,
  pct: null,
  cacheHitRate: null,
  provider: '',
  model: '',
  note: '',
}

/** 从 tokenUsage 投影读缓存命中率（0–1）；投影缺失或不可读时返回 null。 */
function cacheHitRateOf(ctx, session) {
  try {
    const projections = ctx.get('sessionProjections')
    const usage = projections?.stateOf?.(session, 'tokenUsage')
    const totals = usage?.totals
    if (!totals) return null
    const denom = totals.cacheReadTokens + totals.uncachedInputTokens
    if (!(denom > 0)) return null
    return Math.round((totals.cacheReadTokens / denom) * 10000) / 10000
  } catch {
    return null
  }
}

/** context_pressure 工具：读当前会话压力；tokenMeter 缺失时不注册。 */
export function pressureTool(ctx) {
  return {
    name: 'context_pressure',
    description:
      '读取当前会话的上下文压力与缓存命中：pressureTokens（请求体总 token）、真实窗口 window、占用百分比 pct、缓存命中率 cacheHitRate、当前 provider/model。判断该压缩还是该交班时先调它拿数。拿不到的字段为 null。',
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
          cacheHitRate: { oneOf: [{ type: 'number' }, { type: 'null' }], description: '缓存命中率（0–1）= cacheReadTokens / (cacheReadTokens + uncachedInputTokens)；未知时为 null' },
          provider: { type: 'string', description: '当前路由 provider；未知为空串' },
          model: { type: 'string', description: '当前路由 model；未知为空串' },
          note: { type: 'string', description: '读数失败时的错误说明；正常为空串' },
        },
        required: ['pressureTokens', 'surfaceTokens'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (_args, exec) => {
      const session = exec.agent?.session
      if (!session) return { ...EMPTY_PRESSURE }
      try {
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
          cacheHitRate: cacheHitRateOf(ctx, session),
          provider: rc?.provider ?? '',
          model: rc?.model ?? '',
          note: '',
        }
      } catch (error) {
        // 读数失败不阻断对话：返回空值 + 错误说明，模型可据此提示用户。
        return { ...EMPTY_PRESSURE, note: `measure failed: ${String(error?.message ?? error)}` }
      }
    },
  }
}

/** 构造一条不落盘的 system-reminder 消息（只进入本次请求，不写入会话）。 */
function reminderMessage(pct, pressureTokens, window, remindAt) {
  const band = pct >= 95 ? 95 : remindAt
  const text =
    `<system-reminder>上下文压力 ${pct}%（${pressureTokens}/${window}），已过 ${band}% 档；建议 /compact 或交接，可忽略。</system-reminder>`
  return userMessage(text, 'context-ops-reminder')
}

export function apply(ctx, config) {
  const options = resolveConfig(config)

  ctx.effect(() => {
    const dispose = [
      ctx.skills.register(HANDOFF_SKILL),
      ctx.skills.register(DECISION_SKILL),
      ctx.skills.register(DIAGNOSE_SKILL),
    ]
    return () => dispose.forEach((d) => d())
  }, 'context-ops: skills lifecycle')

  if (options.enablePressureTool) {
    // tokenMeter 是独立插件（dsh-base 提供）；缺失时只跳过压力工具，技能照常。
    ctx.inject(['tokenMeter'], (tctx) => {
      tctx.effect(() => {
        const dispose = tctx.tools.register(pressureTool(tctx))
        return () => dispose()
      }, 'context-ops: pressure tool lifecycle')
    })
  }

  if (options.enableCommands) {
    // 斜杠命令：点命令 = 注入一条用户消息，让模型加载对应技能执行（照 /plan 模式）
    ctx.inject(['commands'], (cctx) => {
      cctx.effect(() => {
        const dispose = [
          cctx.commands.register({
            name: 'handoff',
            description: '交接：产出 5 行交接表（目标/现状/下一步/未决/证据）到 CHECKPOINT.md',
            handler: ({ agent, rawInput }) => {
              if (!agent) return { kind: 'error', text: '没有可用的会话。' }
              const extra = rawInput.trim()
              agent.steer(userMessage(extra ? `交接：${extra}` : '交接'))
              return { kind: 'success', text: '已触发交接流程（context-handoff）。' }
            },
          }),
          cctx.commands.register({
            name: 'pressure',
            description: '该压了吗：调 context_pressure 判断当前会话该压缩、该交班、还是照常用',
            handler: ({ agent }) => {
              if (!agent) return { kind: 'error', text: '没有可用的会话。' }
              agent.steer(userMessage('该压了吗'))
              return { kind: 'success', text: '已触发上下文决策（context-decision）。' }
            },
          }),
          cctx.commands.register({
            name: 'diagnose',
            description: '上下文压缩诊断：一次性体检（模型/窗口/压力/落档/能压吗/处方）',
            handler: ({ agent }) => {
              if (!agent) return { kind: 'error', text: '没有可用的会话。' }
              agent.steer(userMessage('上下文诊断'))
              return { kind: 'success', text: '已触发上下文诊断（context-diagnose）。' }
            },
          }),
        ]
        return () => dispose.forEach((d) => d())
      }, 'context-ops: commands lifecycle')
    })
  }

  if (options.enableReminder) {
    // 主动提醒：每轮首步检查压力，超阈值时把一条 system-reminder 拼进本次请求。
    // 走 agent/pre-step（waterfall），消息不落盘、不触发新回合；tokenMeter 缺失时静默跳过。
    const reminded = new WeakMap() // session -> 已提醒的档位
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (decision.kind !== 'enter' || payload.step !== 1) return decision
        const session = payload.agent?.session
        const tokenMeter = ctx.get('tokenMeter')
        if (!session || !tokenMeter) return decision
        const m = tokenMeter.measure(session)
        const window = session.requestContext()?.contextWindow
        if (!window || window <= 0) return decision
        const pct = Math.round((m.totalTokens / window) * 1000) / 10
        if (pct < options.remindAt) {
          reminded.delete(session)
          return decision
        }
        const band = pct >= 95 ? 95 : options.remindAt
        if ((reminded.get(session) ?? 0) >= band) return decision
        reminded.set(session, band)
        return {
          ...decision,
          messages: [...decision.messages, reminderMessage(pct, m.totalTokens, window, options.remindAt)],
        }
      } catch {
        return decision
      }
    })
  }

  ctx.logger?.info?.('context-ops: 技能 + 压力工具 + 斜杠命令已注册')
}
