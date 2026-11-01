/**
 * dsh-context-ops —— 上下文运维插件（自研）
 * 一个包做：
 *   1) 注册「交接」技能（五行 brief，续接/收尾）
 *   2) 注册「上下文决策」技能（读数 → 套阶梯 → 给处方）
 *   3) 注册「上下文诊断」技能（一次体检，逐层核对，给诊断报告）
 *   4) 注册 context_pressure 工具（自包含读数，不依赖外部脚本）+ context_history 工具（趋势/压缩历史）
 *   5) 三个斜杠命令 /handoff、/pressure、/diagnose（可选，无 commands 服务时跳过）
 *   6) 可选人可见提醒：压力过阈值时由 Web Client 在当前会话输入区显示 banner
 * 压缩摘要走强模型 = 在 DSH 原生 compaction-basic 配 summarizationProvider/Model（见 README），
 * 本插件不写死任何账号/模型。
 *
 * 健壮性约定：
 *   - tokenMeter 不在 inject 里：它是独立插件（dsh-base 提供），缺失时只降级掉压力工具，技能照常注册。
 *   - 工具 execute 不抛错：读写失败时返回空值 + note，避免把一次读数故障变成对话故障。
 *   - config 严格校验：未知键报错，已知键类型写错也报错，不静默取反。
 *   - 人可见提醒只读宿主已有 contextPressure projection，不追加 Session 事件、不写入聊天历史；无 Client 时不影响 Host 技能和工具。
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { MODEL_REAL } from './policy.js'
import { HANDOFF_SKILL } from './skills/handoff.js'
import { DECISION_SKILL } from './skills/decision.js'
import { DIAGNOSE_SKILL } from './skills/diagnose.js'

export const name = 'context-ops'
// 只硬依赖技能与工具两个服务；tokenMeter / commands / sessionProjections 都走可选注入。
export const inject = ['skills', 'tools']

/** 允许的配置键；未知键直接报错（等价 schema 的严格校验，但不引 schemastery）。 */
const CONFIG_KEYS = new Set(['enablePressureTool', 'enableCommands', 'enableReminder', 'remindAt', 'handoffAt', 'realWindows'])

/** Client 读取的 wire view：阈值 + 开关。 */
const REMINDER_VIEW_SCHEMA = z.object({
  enabled: z.boolean(),
  remindAt: z.number().int().min(50).max(95),
  handoffAt: z.number().int().min(50).max(95),
})

/**
 * 投影的持久化 state 故意留空：阈值属于「当前进程的配置」，不属于会话。
 * 宿主恢复会话时走 stateSchema.parse(旧缓存) 而不是 init()，若把阈值放进 state，
 * 改过 profile 之后老会话会永久沿用旧阈值（实测：缓存 60 + 当前配置 80 → 仍是 60）。
 * 留空 state 后，view 每次都由当前配置现算，缓存里没有可回退的东西。
 */
const REMINDER_STATE_SCHEMA = z.object({})

/**
 * 压缩信号：只暴露「这个 session 开始过几次摘要压缩」的累计数。
 * 用途是让 Client 在用户真的去压缩时立刻收起提醒，而不是只靠 60 秒定时器猜。
 * 语义边界（已核实宿主行为）：
 *   - compaction/start 表示「开始了一次压缩尝试」，不代表成功，也不代表是用户手动触发
 *     （自动压缩走 agent/pre-step 与 agent/request-error，同样进这个事务）。
 *   - 无可压范围 / busy / 开始前取消，可能根本没有 start，所以不能用它统计「用户按了几次」。
 *   - 宿主不保证 start 与 end 成对（结束标记本身可能写失败），所以不在这里配对算成功。
 */
const COMPACTION_SIGNAL_SCHEMA = z.object({
  startCount: z.number().int().min(0),
})

/**
 * 从 session 事件折叠出压缩信号。只认 compaction/start，返回新对象以满足宿主的
 * `!Object.is(next, previousState)` 变更判定（原地改 state 不会广播给 Client）。
 * @param {{ startCount: number }} state
 * @param {{ type?: string }} event
 */
export function foldCompactionSignal(state, event) {
  const startCount = state && typeof state.startCount === 'number' ? state.startCount : 0
  if (event?.type !== 'compaction/start') return state ?? { startCount: 0 }
  return { startCount: startCount + 1 }
}

/**
 * 校验「实测窗口覆盖表」：键必须是 provider/model。
 * 只允许 provider/model 而不允许光写 model —— 同一个型号在不同线路容量不同，
 * 光按型号覆盖会把一条线路的实测值错用到另一条线路上（比不填更危险）。
 * @param {unknown} input
 * @returns {Record<string, number>}
 */
export function normalizeRealWindows(input) {
  if (input === undefined) return {}
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('context-ops: config "realWindows" must be an object like { "provider/model": 800000 }')
  }
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    // 按第一个 '/' 切成 provider / model：model 自身可能带 '/'（如 vendor/model），所以不能用 split 计数。
    const slash = key.indexOf('/')
    if (slash < 0) {
      throw new Error(`context-ops: realWindows key "${key}" must be "provider/model" (同一个型号在不同线路容量不同)`)
    }
    if (slash === 0) {
      throw new Error(`context-ops: realWindows key "${key}" has an empty provider; use "provider/model"`)
    }
    if (slash === key.length - 1) {
      throw new Error(`context-ops: realWindows key "${key}" has an empty model; use "provider/model"`)
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`context-ops: realWindows["${key}"] must be a positive finite number, got ${JSON.stringify(value)}`)
    }
    // 取整后再校验：0.4 这类值会取整成 0，等于把窗口变成 0 → pct 永远 null，必须拦下。
    const rounded = Math.round(value)
    if (rounded < 1) {
      throw new Error(`context-ops: realWindows["${key}"] must round to at least 1, got ${JSON.stringify(value)}`)
    }
    out[key] = rounded
  }
  return out
}

/**
 * 解析并校验配置：未知键、类型写错都报错，不静默取反或回落。
 * @returns {{ enablePressureTool: boolean, enableCommands: boolean, enableReminder: boolean, remindAt: number, handoffAt: number, realWindows: Record<string, number> }}
 */
export function resolveConfig(config) {
  const input = config ?? {}
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('context-ops: config must be an object')
  }
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`context-ops: unknown config key "${key}"`)
  }
  for (const key of ['enablePressureTool', 'enableCommands', 'enableReminder']) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') {
      throw new Error(`context-ops: config "${key}" must be a boolean, got ${JSON.stringify(input[key])}`)
    }
  }
  for (const key of ['remindAt', 'handoffAt']) {
    if (input[key] !== undefined && (typeof input[key] !== 'number' || !Number.isFinite(input[key]))) {
      throw new Error(`context-ops: config "${key}" must be a finite number, got ${JSON.stringify(input[key])}`)
    }
  }
  const remindAt = Math.min(95, Math.max(50, Math.round(input.remindAt ?? 85)))
  const handoffAt = Math.min(95, Math.max(50, Math.round(input.handoffAt ?? 92)))
  if (handoffAt < remindAt) {
    throw new Error(`context-ops: config "handoffAt" (${handoffAt}) must be greater than or equal to "remindAt" (${remindAt})`)
  }
  return {
    enablePressureTool: input.enablePressureTool ?? true,
    enableCommands: input.enableCommands ?? true,
    enableReminder: input.enableReminder ?? false,
    remindAt,
    handoffAt,
    realWindows: normalizeRealWindows(input.realWindows),
  }
}

/** 路由键：provider/model。光有 model 无法区分线路，所以键要带 provider。 */
export function routeKey(provider, model) {
  if (typeof model !== 'string' || model === '') return ''
  return `${typeof provider === 'string' ? provider : ''}/${model}`
}

/**
 * 取该路由的实测覆盖值；没有就返回 null（退回标称值）。
 * @param {Record<string, number>} realWindows
 * @param {string} provider
 * @param {string} model
 */
export function windowOverrideOf(realWindows, provider, model) {
  if (!realWindows || typeof realWindows !== 'object') return null
  const key = routeKey(provider, model)
  if (!key) return null
  return Object.hasOwn(realWindows, key) ? realWindows[key] : null
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
  declaredWindow: null,
  realWindow: null,
  windowInflated: null,
  windowSource: 'unknown',
  routeKey: '',
  pct: null,
  cacheHitRate: null,
  provider: '',
  model: '',
  note: '',
}

/**
 * 校正窗口口径，顺带做「窗口是否超出插件认定上限」的检测。
 * 有效窗口取「声明」「该路由上限」里更小的那个：声明偏大时会让 pct 偏低，
 * 所以必须按更小的那个算 pct；反过来把大窗口模型特意配小是合法限制，不能放大。
 * 「该路由上限」的优先级：配置的实测安全值（realWindows）> 内置标称值（MODEL_REAL）。
 * 注意它是「安全值」而不是「线路上限」，所以 windowInflated=true 只表示声明超过了这个安全值，
 * 不等于宿主自动压缩不会触发 —— 宿主按声明窗口算，口径见 AUTO_COMPACT。
 * 查表用 hasOwn：型号来自 profile，写成 "toString" 会命中 Object.prototype，
 * 拿到函数 → NaN / 非 JSON 值，工具返回值校验会直接失败。
 * @param {string} model 当前路由 model
 * @param {number|null} declared requestContext 声明的上下文窗口
 * @param {string} provider 当前路由 provider
 * @param {Record<string, number>} realWindows 按 provider/model 配置的实测安全窗口
 */
export function windowFields(model, declared, provider = '', realWindows = {}) {
  const nominal = typeof model === 'string' && Object.hasOwn(MODEL_REAL, model) ? MODEL_REAL[model] : null
  const override = windowOverrideOf(realWindows, provider, model)
  const real = override ?? nominal
  const declaredWindow = typeof declared === 'number' && Number.isFinite(declared) && declared > 0 ? declared : null
  const both = real != null && declaredWindow != null
  const window = both ? Math.min(real, declaredWindow) : (declaredWindow ?? real ?? null)
  // 标记真正等于有效窗口的那个值：多个值相等时优先报有证据含义的 override / nominal。
  const windowSource =
    override != null
      ? declaredWindow != null && declaredWindow < override
        ? 'declared'
        : 'override'
      : nominal != null
        ? declaredWindow != null && declaredWindow < nominal
          ? 'declared'
          : 'nominal'
        : declaredWindow != null
          ? 'declared'
          : 'unknown'
  return {
    window,
    declaredWindow,
    realWindow: real,
    windowInflated: both ? declaredWindow > real : null,
    windowSource,
    routeKey: routeKey(provider, model),
  }
}

/** 只接受有限、非负数字；宿主投影异常时返回 null，避免污染工具 schema。 */
function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** 从 tokenUsage 投影读缓存命中率（0–1）；投影缺失或不可读时返回 null。 */
function cacheHitRateOf(ctx, session) {
  try {
    const projections = ctx.get('sessionProjections')
    const usage = projections?.stateOf?.(session, 'tokenUsage')
    const totals = usage?.totals
    if (!totals) return null
    const cacheRead = finiteNonNegative(totals.cacheReadTokens)
    const uncached = finiteNonNegative(totals.uncachedInputTokens)
    const cacheWrite = finiteNonNegative(totals.cacheWriteTokens)
    if (cacheRead == null || uncached == null || cacheWrite == null) return null
    const denom = cacheRead + cacheWrite + uncached
    if (!(denom > 0)) return null
    return Math.max(0, Math.min(1, Math.round((cacheRead / denom) * 10000) / 10000))
  } catch {
    return null
  }
}

/** context_pressure 工具：读当前会话压力；tokenMeter 缺失时不注册。 */
export function pressureTool(ctx, options = {}) {
  const realWindows = options.realWindows ?? {}
  return {
    name: 'context_pressure',
    description:
      '读取当前会话的上下文压力与缓存命中：pressureTokens（请求体总 token）、有效窗口 window（= min 声明值与该路由上限）、占用百分比 pct、缓存命中率 cacheHitRate、当前 provider/model，窗口虚高检测（declaredWindow / realWindow / windowInflated），以及 windowSource 说明这个窗口数字的依据（override 实测配置 / nominal 内置标称 / declared 仅声明值 / unknown）。判断该压缩还是该交班时先调它拿数。拿不到的字段为 null。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pressureTokens: { type: 'number', description: '请求体总 token（压力）' },
          surfaceTokens: { type: 'number', description: '对话面 token' },
          window: { oneOf: [{ type: 'number' }, { type: 'null' }], description: '有效上下文窗口 = min(declaredWindow, realWindow)；未知时为 null' },
          declaredWindow: { oneOf: [{ type: 'number' }, { type: 'null' }], description: '路由/配置声明的上下文窗口；未知时为 null' },
          realWindow: { oneOf: [{ type: 'number' }, { type: 'null' }], description: '该路由的容量上限估计：realWindows 配了实测值则用它，否则退回内置标称值（型号通用规格，不代表当前线路实测支持）；都未知时为 null' },
          windowInflated: {
            oneOf: [{ type: 'boolean' }, { type: 'null' }],
            description: '声明窗口高于 realWindow（不等于宿主自动压缩失效，分支含义见 context-diagnose）；无法判断时为 null',
          },
          windowSource: {
            type: 'string',
            enum: ['override', 'nominal', 'declared', 'unknown'],
            description: '窗口数字的依据：override 用户按 provider/model 配置的实测值；nominal 内置标称值（不代表当前线路一定支持）；declared 只有声明值；unknown 无可用信息',
          },
          routeKey: { type: 'string', description: '本会话路由键 provider/model，用于在 realWindows 里覆盖实测值；未知为空串' },
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
      // 没有会话时别返回「0 token」（会被读成「上下文很空」），留 note 说明拿不到。
      if (!session) return { ...EMPTY_PRESSURE, note: 'no session: 没有可读的会话' }
      try {
        const m = ctx.tokenMeter.measure(session)
        const rc = session.requestContext()
        const windows = windowFields(rc?.model ?? '', rc?.contextWindow ?? null, rc?.provider ?? '', realWindows)
        const pressureTokens = finiteNonNegative(m?.totalTokens)
        const surfaceTokens = finiteNonNegative(m?.surfaceTokens)
        if (pressureTokens == null || surfaceTokens == null) {
          return {
            ...EMPTY_PRESSURE,
            ...windows,
            pressureTokens: pressureTokens ?? 0,
            surfaceTokens: surfaceTokens ?? 0,
            provider: rc?.provider ?? '',
            model: rc?.model ?? '',
            note: 'measure returned invalid token counts; pressure unavailable',
          }
        }
        const pct =
          windows.window != null && windows.window > 0
            ? Math.round((pressureTokens / windows.window) * 1000) / 10
            : null
        return {
          ...windows,
          pressureTokens,
          surfaceTokens,
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

/** context_history 工具：从会话事件里算趋势（峰值/最后）+ 压缩历史（次数/成功/失败）。 */
export function historyTool(_ctx) {
  return {
    name: 'context_history',
    description:
      '读取当前会话的上下文历史：峰值 token、最后 token、压缩次数/成功/失败。用于看压力趋势和复盘压缩效果（配合 context_pressure 用）。注意 peakTokens/lastTokens 是「输入侧 token」（input+cacheRead+cacheWrite），不含输出，和 context_pressure 的 pressureTokens 口径不同，别直接相减。拿不到的字段为 null。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          peakTokens: { oneOf: [{ type: 'number' }, { type: 'null' }], description: '历史峰值输入侧 token（inputTokens+cacheReadTokens+cacheWriteTokens 的最大值）；无 usage 时为 null' },
          lastTokens: { oneOf: [{ type: 'number' }, { type: 'null' }], description: '最后一次请求的输入侧 token；无 usage 时为 null' },
          compactionCount: { type: 'number', description: '压缩尝试次数（compaction/start 计数）' },
          compactionSuccess: { type: 'number', description: '压缩成功次数（compaction/summary 计数）' },
          compactionError: { type: 'number', description: '压缩失败次数（compaction/end 且带 error 的计数）' },
          note: { type: 'string', description: '读数失败说明；正常为空串' },
        },
        required: ['compactionCount', 'compactionSuccess', 'compactionError'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (_args, exec) => {
      const session = exec.agent?.session
      if (!session) {
        return { peakTokens: null, lastTokens: null, compactionCount: 0, compactionSuccess: 0, compactionError: 0, note: 'no session: 没有可读的会话' }
      }
      try {
        const events = session.snapshotEvents()
        let peak = null
        let last = null
        let start = 0
        let ok = 0
        let err = 0
        for (const e of events) {
          const t = e?.type
          // 宿主只有 compaction/start | summary | end；失败记在 compaction/end.data.error。
          // 「compaction/summary-error」是内存里的 waterfall 钩子名，不落盘，数它永远是 0。
          if (t === 'compaction/start') start++
          else if (t === 'compaction/summary') ok++
          else if (t === 'compaction/end' && e.data?.error !== undefined) err++
          else if (t === 'assistant/message' && e.data?.usage) {
            const u = e.data.usage
            const inputTokens = finiteNonNegative(u.inputTokens)
            const cacheReadTokens = finiteNonNegative(u.cacheReadTokens)
            const cacheWriteTokens = finiteNonNegative(u.cacheWriteTokens)
            if (inputTokens == null || cacheReadTokens == null || cacheWriteTokens == null) continue
            const ctxTokens = inputTokens + cacheReadTokens + cacheWriteTokens
            if (!Number.isSafeInteger(ctxTokens)) continue
            if (peak == null || ctxTokens > peak) peak = ctxTokens
            last = ctxTokens
          }
        }
        const note = events.some((e) => e?.type === 'assistant/message' && e.data?.usage &&
          (finiteNonNegative(e.data.usage.inputTokens) == null || finiteNonNegative(e.data.usage.cacheReadTokens) == null || finiteNonNegative(e.data.usage.cacheWriteTokens) == null))
          ? 'some invalid usage entries were skipped'
          : ''
        return { peakTokens: peak, lastTokens: last, compactionCount: start, compactionSuccess: ok, compactionError: err, note }
      } catch (error) {
        return {
          peakTokens: null,
          lastTokens: null,
          compactionCount: 0,
          compactionSuccess: 0,
          compactionError: 0,
          note: `history read failed: ${String(error?.message ?? error)}`,
        }
      }
    },
  }
}

export function apply(ctx, config) {
  const options = resolveConfig(config)

  if (options.enableReminder) {
    ctx.inject(['sessionProjections'], (pctx) => {
      pctx.effect(() => pctx.sessionProjections.register({
        key: 'contextOpsReminderConfig',
        // 2：state 从「存阈值」改成「空对象」，旧缓存行不再被采用。
        stateVersion: 2,
        stateSchema: REMINDER_STATE_SCHEMA,
        init: () => ({}),
        apply: (state) => state,
        wire: {
          viewSchema: REMINDER_VIEW_SCHEMA,
          // 唯一定义来源：当前进程的插件配置。不读 state，旧会话拿不到旧阈值。
          view: () => ({ enabled: options.enableReminder, remindAt: options.remindAt, handoffAt: options.handoffAt }),
        },
      }), 'context-ops: reminder config projection')

      pctx.effect(() => pctx.sessionProjections.register({
        key: 'contextOpsCompactionSignal',
        stateVersion: 1,
        stateSchema: COMPACTION_SIGNAL_SCHEMA,
        init: () => ({ startCount: 0 }),
        apply: (state, event) => foldCompactionSignal(state, event),
        wire: {
          viewSchema: COMPACTION_SIGNAL_SCHEMA,
          view: (state) => ({ startCount: state?.startCount ?? 0 }),
        },
      }), 'context-ops: compaction signal projection')
    })
  }

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
        const dispose = [
          tctx.tools.register(pressureTool(tctx, options)),
          tctx.tools.register(historyTool(tctx)),
        ]
        return () => dispose.forEach((d) => d())
      }, 'context-ops: pressure + history tool lifecycle')
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
            input: { hint: '可选：一句话说明交接主题' },
            handler: ({ agent, rawInput, signal }) => {
              if (!agent) return { kind: 'error', text: '没有可用的会话。' }
              if (signal?.aborted) return { kind: 'error', text: '已取消，没有触发交接。' }
              const extra = typeof rawInput === 'string' ? rawInput.trim() : ''
              try {
                agent.steer(userMessage(extra ? `交接：${extra}` : '交接'))
                return { kind: 'success', text: '已触发交接流程（context-handoff）。' }
              } catch (error) {
                return { kind: 'error', text: `触发交接失败：${String(error?.message ?? error)}` }
              }
            },
          }),
          cctx.commands.register({
            name: 'pressure',
            description: '该压了吗：调 context_pressure 判断当前会话该压缩、该交班、还是照常用',
            handler: ({ agent, signal }) => {
              if (!agent) return { kind: 'error', text: '没有可用的会话。' }
              if (signal?.aborted) return { kind: 'error', text: '已取消，没有触发上下文决策。' }
              try {
                agent.steer(userMessage('该压了吗'))
                return { kind: 'success', text: '已触发上下文决策（context-decision）。' }
              } catch (error) {
                return { kind: 'error', text: `触发上下文决策失败：${String(error?.message ?? error)}` }
              }
            },
          }),
          cctx.commands.register({
            name: 'diagnose',
            description: '上下文压缩诊断：一次性体检（模型/窗口/压力/落档/能压吗/处方）',
            handler: ({ agent, signal }) => {
              if (!agent) return { kind: 'error', text: '没有可用的会话。' }
              if (signal?.aborted) return { kind: 'error', text: '已取消，没有触发上下文诊断。' }
              try {
                agent.steer(userMessage('上下文诊断'))
                return { kind: 'success', text: '已触发上下文诊断（context-diagnose）。' }
              } catch (error) {
                return { kind: 'error', text: `触发上下文诊断失败：${String(error?.message ?? error)}` }
              }
            },
          }),
        ]
        return () => dispose.forEach((d) => d())
      }, 'context-ops: commands lifecycle')
    })
  }

  ctx.logger?.info?.(
    `context-ops: 技能 + 压力/历史工具 + 斜杠命令已注册${options.enableReminder ? `（Web banner 提醒 ${options.remindAt}% / 交接确认提示 ${options.handoffAt}%）` : ''}`,
  )
}
