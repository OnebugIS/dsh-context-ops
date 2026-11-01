/** apply() 注册路径测试：技能 / 工具 / 命令 / 主动提醒，以及各自缺失时的降级。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply, historyTool } from '../lib/index.js'

/**
 * 最小 ctx 替身：只实现 apply() 用到的服务与钩子。
 * @param {{commands?: boolean, tokenMeter?: object|null, systemPrompt?: boolean, config?: object}} opts
 */
function mockCtx(opts = {}) {
  const state = { skills: [], tools: [], commands: [], contexts: [], projections: [], listeners: new Map(), warns: [] }
  const ctx = {
    skills: { register: (s) => (state.skills.push(s), () => {}) },
    tools: { register: (t) => (state.tools.push(t), () => {}) },
    commands: opts.commands === false ? undefined : { register: (c) => (state.commands.push(c), () => {}) },
    systemPrompt:
      opts.systemPrompt === false
        ? undefined
        : { context: (c) => (state.contexts.push(c), () => {}) },
    tokenMeter: opts.tokenMeter === undefined ? { measure: () => ({ totalTokens: 0, surfaceTokens: 0 }) } : opts.tokenMeter,
    sessionProjections:
      opts.sessionProjections === false
        ? undefined
        : { register: (def) => (state.projections.push(def), () => {}) },
    effect(fn) {
      fn()
    },
    inject(deps, cb) {
      // 真实 loader：依赖服务缺失就不回调
      for (const dep of deps) if (!ctx[dep]) return
      cb(ctx)
    },
    get(name) {
      return ctx[name]
    },
    on(event, handler) {
      state.listeners.set(event, handler)
    },
    logger: { info() {}, warn: (m) => state.warns.push(String(m)) },
  }
  return { ctx, state }
}

/** 造一个假会话：可指定 token 数与声明窗口。 */
function session(declaredWindow, model = 'deepseek-flash') {
  return { requestContext: () => ({ contextWindow: declaredWindow, model, provider: 'p' }) }
}

/** 用固定 token 数造 tokenMeter。 */
function meter(n) {
  return { measure: () => ({ totalTokens: n, surfaceTokens: 1 }) }
}

test('apply: 三个技能 + 三个命令 + 两个工具都在；默认不挂提醒', () => {
  const { ctx, state } = mockCtx()
  apply(ctx, {})
  assert.deepEqual(
    state.skills.map((s) => s.name),
    ['context-handoff', 'context-decision', 'context-diagnose'],
  )
  assert.deepEqual(
    state.commands.map((c) => c.name),
    ['handoff', 'pressure', 'diagnose'],
  )
  assert.deepEqual(
    state.tools.map((t) => t.name),
    ['context_pressure', 'context_history'],
  )
  assert.equal(state.contexts.length, 0, '默认关提醒：不该注册运行时上下文')
  assert.equal(state.listeners.has('agent/pre-step'), false, '不该再借 pre-step 注入消息')
})

test('apply: 无 commands 服务时只注册技能，不报错', () => {
  const { ctx, state } = mockCtx({ commands: false })
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(state.skills.length, 3)
  assert.equal(state.commands.length, 0)
})

test('apply: tokenMeter 缺失时降级掉两个工具，技能照常', () => {
  const { ctx, state } = mockCtx({ tokenMeter: null })
  apply(ctx, {})
  assert.equal(state.skills.length, 3)
  assert.equal(state.tools.length, 0)
  assert.equal(state.commands.length, 3)
})

test('apply: 无 systemPrompt 服务时提醒静默降级', () => {
  const { ctx, state } = mockCtx({ systemPrompt: false })
  assert.doesNotThrow(() => apply(ctx, { enableReminder: true }))
  assert.equal(state.contexts.length, 0)
  assert.equal(state.skills.length, 3)
})

test('apply: 开关全关时只剩技能', () => {
  const { ctx, state } = mockCtx()
  apply(ctx, { enablePressureTool: false, enableCommands: false })
  assert.equal(state.skills.length, 3)
  assert.equal(state.tools.length, 0)
  assert.equal(state.commands.length, 0)
})

test('人可见提醒：Host 不再注册运行时上下文，Client banner 读取 contextPressure projection', () => {
  const { ctx, state } = mockCtx()
  apply(ctx, { enableReminder: true, remindAt: 60 })
  assert.equal(state.contexts.length, 0, '不再把提醒注入隐藏 runtime-context')
  assert.equal(state.listeners.has('agent/pre-step'), false)
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(client, /conversation\.input\.dock/)
  assert.match(client, /useProjection\('contextPressure'\)/)
  assert.match(client, /useProjection\('contextOpsReminderConfig'\)/)
  assert.match(client, /useProjection\('contextOpsCompactionSignal'\)/)
  // 优先 projectedTokens（压缩后会先回落的那个估算值），pressureTokens 只作回退。
  assert.match(client, /pressure\?\.projectedTokens/)
  assert.match(client, /pressure\?\.pressureTokens/)
  assert.match(client, /reminder\.handoffAt/)
  assert.match(client, /reminder\.remindAt/)
  // 四态必须存在：不能把「读数不可用」当成「压力回落」，否则 toast 会被误清后复活。
  assert.match(client, /'unknown'/)
  assert.match(client, /'low'/)
})

test('reminder projection: 旧会话缓存不得把阈值带回旧值（state 留空 + view 现算）', () => {
  const { ctx, state } = mockCtx()
  apply(ctx, { enableReminder: true, remindAt: 80, handoffAt: 95 })

  const def = state.projections.find((p) => p.key === 'contextOpsReminderConfig')
  assert.ok(def, 'enableReminder: true 时必须注册 contextOpsReminderConfig 投影')
  assert.equal(def.stateVersion, 2, 'state 语义变了就要升版本号，否则旧缓存行会被 parse 后继续生效')

  // 宿主恢复路径：stateSchema.parse(行里的旧值)，不是 init()。
  // 旧版本缓存里带着 remindAt: 60；state 留空后它落不进任何可读字段。
  const restored = def.stateSchema.parse({ enabled: true, remindAt: 60, handoffAt: 92 })
  assert.deepEqual(restored, {}, 'state 不得保留阈值，否则老会话会永久沿用旧值')

  // view 只反映当前进程配置（80/95），不是缓存里的 60/92。
  assert.deepEqual(def.wire.view(def.apply(restored, {})), { enabled: true, remindAt: 80, handoffAt: 95 })
})

test('compaction signal projection: 只累计 compaction/start，其他事件不变', () => {
  const { ctx, state } = mockCtx()
  apply(ctx, { enableReminder: true })

  const def = state.projections.find((p) => p.key === 'contextOpsCompactionSignal')
  assert.ok(def, 'enableReminder: true 时必须注册压缩信号投影')
  assert.equal(def.stateVersion, 1)
  const initial = def.init()
  assert.deepEqual(initial, { startCount: 0 })
  assert.deepEqual(def.apply(initial, { type: 'assistant/message' }), { startCount: 0 })
  const once = def.apply(initial, { type: 'compaction/start' })
  assert.deepEqual(once, { startCount: 1 })
  assert.deepEqual(def.apply(once, { type: 'compaction/summary' }), { startCount: 1 })
  assert.deepEqual(def.wire.view(once), { startCount: 1 })
})

test('reminder projection: 没有 sessionProjections 服务时静默降级', () => {
  const { ctx, state } = mockCtx({ sessionProjections: false })
  assert.doesNotThrow(() => apply(ctx, { enableReminder: true }))
  assert.equal(state.projections.length, 0)
  assert.equal(state.skills.length, 3)
})

test('context_history: 压缩失败数 compaction/end 的 error，不数不存在的 summary-error', async () => {
  const events = [
    { type: 'compaction/start', data: { compactionId: 'a' } },
    { type: 'compaction/end', data: { compactionId: 'a', error: 'context overflow' } },
    { type: 'compaction/start', data: { compactionId: 'b' } },
    { type: 'compaction/summary', data: { compactionId: 'b' } },
    { type: 'compaction/end', data: { compactionId: 'b' } },
    { type: 'assistant/message', data: { usage: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5 } } },
  ]
  const tool = historyTool({})
  const out = await tool.execute({}, { agent: { session: { snapshotEvents: () => events } } })
  assert.equal(out.compactionCount, 2)
  assert.equal(out.compactionSuccess, 1)
  assert.equal(out.compactionError, 1, '失败必须以 compaction/end.data.error 计')
  assert.equal(out.peakTokens, 1050, '输入侧 = input + cacheRead + cacheWrite')
  assert.equal(out.lastTokens, 35)
})

test('context_history: 非法 usage 会跳过并说明 note', async () => {
  const events = [
    { type: 'assistant/message', data: { usage: { inputTokens: '100', cacheReadTokens: 20, cacheWriteTokens: 0 } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: NaN } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5 } } },
  ]
  const out = await historyTool({}).execute({}, { agent: { session: { snapshotEvents: () => events } } })
  assert.equal(out.peakTokens, 35)
  assert.equal(out.lastTokens, 35)
  assert.match(out.note, /invalid usage/)
})

test('context_history: 无会话时给出 note，不假装 0', async () => {
  const out = await historyTool({}).execute({}, {})
  assert.match(out.note, /no session/)
  assert.equal(out.peakTokens, null)
})
