import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LADDER, HARD_RULE, FAILURE_ATTRIBUTION, REAL_WINDOWS } from '../lib/policy.js'
import { HANDOFF_SKILL } from '../lib/skills/handoff.js'
import { DECISION_SKILL } from '../lib/skills/decision.js'
import { DIAGNOSE_SKILL } from '../lib/skills/diagnose.js'
import { pressureTool, resolveConfig, windowFields } from '../lib/index.js'

test('阶梯是 6 档且包含关键阈值', () => {
  const tiers = ['<30%', '30–50%', '50–70%', '70–85%', '85–100%', '≥100%']
  for (const t of tiers) assert.ok(LADDER.includes(t), `缺档位 ${t}`)
})

test('决策与诊断共用同一份阶梯、硬判据、三归因', () => {
  for (const s of [DECISION_SKILL, DIAGNOSE_SKILL]) {
    assert.ok(s.content.includes(LADDER), `${s.name} 未嵌入统一阶梯`)
    assert.ok(s.content.includes(HARD_RULE), `${s.name} 未嵌入硬判据`)
    assert.ok(s.content.includes(FAILURE_ATTRIBUTION), `${s.name} 未嵌入三归因`)
  }
})

test('诊断技能带真实窗口表', () => {
  assert.ok(DIAGNOSE_SKILL.content.includes(REAL_WINDOWS))
})

test('三个技能名唯一', () => {
  const names = [HANDOFF_SKILL.name, DECISION_SKILL.name, DIAGNOSE_SKILL.name]
  assert.equal(new Set(names).size, 3)
})

test('context_pressure 工具 schema 合法，window/pct 可空', () => {
  const tool = pressureTool(null)
  assert.equal(tool.name, 'context_pressure')
  assert.equal(tool.parameters.type, 'object')
  assert.equal(tool.output.schema.type, 'object')
  const props = tool.output.schema.properties
  assert.ok(props.pressureTokens, '缺 pressureTokens')
  assert.ok(props.surfaceTokens, '缺 surfaceTokens')
  assert.ok(props.window, '缺 window')
  assert.ok(props.pct, '缺 pct')
  // window/pct 允许 null（拿不到窗口时）
  for (const key of ['window', 'pct']) {
    assert.deepEqual(props[key].oneOf?.map((x) => x.type), ['number', 'null'], `${key} 应为 number|null`)
  }
})

test('policy 常量非空且稳定', () => {
  assert.ok(HARD_RULE.includes('0.95'))
  assert.ok(FAILURE_ATTRIBUTION.includes('summary is not smaller'))
  assert.ok(REAL_WINDOWS.includes('1,048,576'))
})

test('resolveConfig: 默认值、开关与未知键', () => {
  assert.deepEqual(resolveConfig(), {
    enablePressureTool: true,
    enableCommands: true,
    enableReminder: false,
    remindAt: 85,
    handoffAt: 92,
  })
  assert.deepEqual(resolveConfig({ enablePressureTool: false, enableReminder: true, remindAt: 70 }), {
    enablePressureTool: false,
    enableCommands: true,
    enableReminder: true,
    remindAt: 70,
    handoffAt: 92,
  })
  // remindAt / handoffAt 会被夹到 50–95
  assert.equal(resolveConfig({ remindAt: 10 }).remindAt, 50)
  assert.equal(resolveConfig({ remindAt: 120 }).remindAt, 95)
  assert.equal(resolveConfig({ handoffAt: 10 }).handoffAt, 50)
  assert.equal(resolveConfig({ handoffAt: 120 }).handoffAt, 95)
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key/)
})

test('context_pressure: 从 tokenUsage 投影算缓存命中率', async () => {
  const ctx = {
    tokenMeter: { measure() { return { totalTokens: 100, surfaceTokens: 80 } } },
    get(name) {
      if (name !== 'sessionProjections') return undefined
      return {
        stateOf: () => ({
          totals: { cacheReadTokens: 900, uncachedInputTokens: 100, outputTokens: 0, cacheWriteTokens: 0 },
        }),
      }
    },
  }
  const tool = pressureTool(ctx)
  const out = await tool.execute(
    {},
    { agent: { session: { requestContext: () => ({ contextWindow: 200, provider: 'p', model: 'm' }) } } },
  )
  assert.equal(out.cacheHitRate, 0.9)
  assert.equal(out.pct, 50)
})

test('context_pressure: 无 agent 时返回空值 + note，不假装「0 压力」', async () => {
  const tool = pressureTool({})
  const out = await tool.execute({}, {})
  assert.equal(out.pressureTokens, 0)
  assert.equal(out.window, null)
  assert.match(out.note, /no session/)
})

test('context_pressure: measure 抛错时兜底', async () => {
  const ctx = { tokenMeter: { measure() { throw new Error('boom') } } }
  const tool = pressureTool(ctx)
  const out = await tool.execute({}, { agent: { session: {} } })
  assert.equal(out.pressureTokens, 0)
  assert.match(out.note, /boom/)
})

test('windowFields: 声明虚高 → 按真实上限收窄并标记', () => {
  // deepseek-flash 真实 1M，被配成 2M
  const w = windowFields('deepseek-flash', 2097152)
  assert.deepEqual(w, { window: 1048576, declaredWindow: 2097152, realWindow: 1048576, windowInflated: true })
})

test('windowFields: 声明偏小是合法限制，不放大、不报虚高', () => {
  const w = windowFields('deepseek-flash', 131072)
  assert.deepEqual(w, { window: 131072, declaredWindow: 131072, realWindow: 1048576, windowInflated: false })
})

test('windowFields: 型号未知或缺声明时为 null，不瞎猜', () => {
  assert.deepEqual(windowFields('some-unknown-model', 200000), {
    window: 200000,
    declaredWindow: 200000,
    realWindow: null,
    windowInflated: null,
  })
  assert.deepEqual(windowFields('glm-5.3', null), {
    window: 131072,
    declaredWindow: null,
    realWindow: 131072,
    windowInflated: null,
  })
  assert.deepEqual(windowFields('some-unknown-model', null), {
    window: null,
    declaredWindow: null,
    realWindow: null,
    windowInflated: null,
  })
})

test('context_pressure: 声明窗口虚高时 pct 按真实上限算', async () => {
  const ctx = { tokenMeter: { measure() { return { totalTokens: 1048576 / 2, surfaceTokens: 1 } } } }
  const tool = pressureTool(ctx)
  const out = await tool.execute(
    {},
    { agent: { session: { requestContext: () => ({ contextWindow: 2097152, provider: 'p', model: 'deepseek-flash' }) } } },
  )
  assert.equal(out.window, 1048576)
  assert.equal(out.windowInflated, true)
  assert.equal(out.pct, 50)
})

test('context_pressure: 空值兜底也带窗口字段', async () => {
  const out = await pressureTool({}).execute({}, {})
  assert.equal(out.declaredWindow, null)
  assert.equal(out.realWindow, null)
  assert.equal(out.windowInflated, null)
})

test('windowFields: 型号撞上 Object.prototype 也不炸（toString/constructor）', () => {
  // 不用 hasOwn 的话会拿到函数 → NaN / 非 JSON 值，工具返回值校验会直接失败
  for (const model of ['toString', 'constructor', 'valueOf', '__proto__', 'hasOwnProperty']) {
    const w = windowFields(model, 1000)
    assert.deepEqual(w, { window: 1000, declaredWindow: 1000, realWindow: null, windowInflated: null }, model)
    assert.ok(Number.isFinite(w.window), `${model} 的 window 必须是有限数`)
  }
})

test('windowFields: 非法 declared（0/负数/NaN/字符串）当作未知', () => {
  for (const bad of [0, -1, NaN, '131072', Infinity]) {
    assert.deepEqual(windowFields('deepseek-flash', bad), {
      window: 1048576,
      declaredWindow: null,
      realWindow: 1048576,
      windowInflated: null,
    })
  }
})

test('resolveConfig: 类型写错要报错，不静默取反', () => {
  assert.throws(() => resolveConfig({ enablePressureTool: 'false' }), /must be a boolean/)
  assert.throws(() => resolveConfig({ enableCommands: 0 }), /must be a boolean/)
  assert.throws(() => resolveConfig({ enableReminder: null }), /must be a boolean/)
  assert.throws(() => resolveConfig({ remindAt: '70' }), /must be a finite number/)
  assert.throws(() => resolveConfig({ remindAt: Infinity }), /must be a finite number/)
  // 合法值照常
  assert.equal(resolveConfig({ remindAt: 70 }).remindAt, 70)
  assert.equal(resolveConfig({ enableReminder: true }).enableReminder, true)
})
