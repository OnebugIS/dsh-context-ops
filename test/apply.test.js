/** apply() 注册路径测试：技能 / 工具 / 命令 / 主动提醒，以及各自缺失时的降级。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply, historyTool } from '../lib/index.js'

/**
 * 最小 ctx 替身：只实现 apply() 用到的服务与钩子。
 * @param {{commands?: boolean, tokenMeter?: object|null, systemPrompt?: boolean, config?: object}} opts
 */
function mockCtx(opts = {}) {
  const state = { skills: [], tools: [], commands: [], contexts: [], listeners: new Map(), warns: [] }
  const ctx = {
    skills: { register: (s) => (state.skills.push(s), () => {}) },
    tools: { register: (t) => (state.tools.push(t), () => {}) },
    commands: opts.commands === false ? undefined : { register: (c) => (state.commands.push(c), () => {}) },
    systemPrompt:
      opts.systemPrompt === false
        ? undefined
        : { context: (c) => (state.contexts.push(c), () => {}) },
    tokenMeter: opts.tokenMeter === undefined ? { measure: () => ({ totalTokens: 0, surfaceTokens: 0 }) } : opts.tokenMeter,
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

test('提醒: 注册成运行时上下文，不是伪造 user 消息', () => {
  const { ctx, state } = mockCtx()
  apply(ctx, { enableReminder: true, remindAt: 70 })
  assert.equal(state.contexts.length, 1)
  const entry = state.contexts[0]
  assert.equal(entry.name, 'context-ops:pressure-reminder')
  assert.ok(Number.isFinite(entry.order), 'order 必须是有限数')
  assert.equal(typeof entry.text, 'function', 'text 要能每次装配重新求值')
  assert.equal(state.listeners.has('agent/pre-step'), false)
})

test('提醒: 未到阈值给空串，到阈值给提示；同档文本完全一致（不抖动快照）', () => {
  const tok = { n: 0 }
  const { ctx, state } = mockCtx({ tokenMeter: { measure: () => ({ totalTokens: tok.n, surfaceTokens: 1 }) } })
  apply(ctx, { enableReminder: true, remindAt: 70 })
  const text = (n) => ((tok.n = n), state.contexts[0].text({ agent: { session: session(1000) } }))

  assert.equal(text(600), '', '60% 不该提醒')
  const at80 = text(800)
  assert.match(at80, /70% 档/)
  assert.equal(text(850), at80, '同档位文本必须逐字相同，否则快照每轮重写')
  const at96 = text(960)
  assert.match(at96, /92% 交接线/, '过交接线要切到强制交接文本')
  assert.equal(text(100), '', '回落后要自动消失')
})

test('提醒: 文本里不放精确百分比（否则每轮都要重写快照）', () => {
  const { ctx, state } = mockCtx({ tokenMeter: meter(838861) })
  apply(ctx, { enableReminder: true, remindAt: 70 })
  const out = state.contexts[0].text({ agent: { session: session(1048576) } })
  assert.doesNotMatch(out, /\d+\.\d+%/, '不该出现 80.0% 这类会变的小数')
  assert.doesNotMatch(out, /838861/, '不该出现 token 绝对值')
})

test('提醒: 无窗口 / 无会话 / 读数抛错 都退化成空串，且留 warn', () => {
  const { ctx, state } = mockCtx({
    tokenMeter: {
      measure: () => {
        throw new Error('boom')
      },
    },
  })
  apply(ctx, { enableReminder: true, remindAt: 70 })
  const entry = state.contexts[0]
  assert.equal(entry.text({ agent: undefined }), '')
  assert.equal(entry.text({ agent: { session: { requestContext: () => ({}) } } }), '')
  assert.equal(entry.text({ agent: { session: session(1000) } }), '')
  assert.ok(state.warns.some((w) => w.includes('reminder skipped')), '读数失败要留 warn，不能静默')
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

test('context_history: 无会话时给出 note，不假装 0', async () => {
  const out = await historyTool({}).execute({}, {})
  assert.match(out.note, /no session/)
  assert.equal(out.peakTokens, null)
})
