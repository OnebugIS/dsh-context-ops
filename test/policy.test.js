import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LADDER, HARD_RULE, FAILURE_ATTRIBUTION, REAL_WINDOWS, WINDOW_EVIDENCE } from '../lib/policy.js'
import { HANDOFF_SKILL } from '../lib/skills/handoff.js'
import { DECISION_SKILL } from '../lib/skills/decision.js'
import { DIAGNOSE_SKILL } from '../lib/skills/diagnose.js'
import {
  pressureTool,
  resolveConfig,
  windowFields,
  normalizeRealWindows,
  routeKey,
  windowOverrideOf,
} from '../lib/index.js'

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
  assert.ok(WINDOW_EVIDENCE.includes('override'), '窗口证据来源要写明 override')
})

test('resolveConfig: 默认值、开关与未知键', () => {
  assert.deepEqual(resolveConfig(), {
    enablePressureTool: true,
    enableCommands: true,
    enableReminder: false,
    remindAt: 85,
    handoffAt: 92,
    realWindows: {},
  })
  assert.deepEqual(resolveConfig({ enablePressureTool: false, enableReminder: true, remindAt: 70 }), {
    enablePressureTool: false,
    enableCommands: true,
    enableReminder: true,
    remindAt: 70,
    handoffAt: 92,
    realWindows: {},
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

test('windowFields: 声明窗口更小则 declared 是有效窗口来源', () => {
  const w = windowFields('deepseek-v4-pro', 800000, 'zicode')
  assert.deepEqual(w, {
    window: 800000,
    declaredWindow: 800000,
    realWindow: 1048576,
    windowInflated: false,
    windowSource: 'declared',
    routeKey: 'zicode/deepseek-v4-pro',
  })
})

test('windowFields: 声明虚高 → 按真实上限收窄并标记', () => {
  // deepseek-flash 标称 1M，被配成 2M
  const w = windowFields('deepseek-flash', 2097152)
  assert.deepEqual(w, {
    window: 1048576,
    declaredWindow: 2097152,
    realWindow: 1048576,
    windowInflated: true,
    windowSource: 'nominal',
    routeKey: '/deepseek-flash',
  })
})

test('windowFields: 声明偏小是合法限制，不放大、不报虚高', () => {
  const w = windowFields('deepseek-flash', 131072)
  assert.deepEqual(w, {
    window: 131072,
    declaredWindow: 131072,
    realWindow: 1048576,
    windowInflated: false,
    windowSource: 'declared',
    routeKey: '/deepseek-flash',
  })
})

test('windowFields: 型号未知或缺声明时为 null，不瞎猜', () => {
  assert.deepEqual(windowFields('some-unknown-model', 200000), {
    window: 200000,
    declaredWindow: 200000,
    realWindow: null,
    windowInflated: null,
    windowSource: 'declared',
    routeKey: '/some-unknown-model',
  })
  assert.deepEqual(windowFields('glm-5.3', null), {
    window: 131072,
    declaredWindow: null,
    realWindow: 131072,
    windowInflated: null,
    windowSource: 'nominal',
    routeKey: '/glm-5.3',
  })
  assert.deepEqual(windowFields('some-unknown-model', null), {
    window: null,
    declaredWindow: null,
    realWindow: null,
    windowInflated: null,
    windowSource: 'unknown',
    routeKey: '/some-unknown-model',
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
    assert.deepEqual(
      w,
      {
        window: 1000,
        declaredWindow: 1000,
        realWindow: null,
        windowInflated: null,
        windowSource: 'declared',
        routeKey: `/${model}`,
      },
      model,
    )
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
      windowSource: 'nominal',
      routeKey: '/deepseek-flash',
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

test('realWindows: 键必须带 provider，值是正有限数', () => {
  assert.deepEqual(normalizeRealWindows(undefined), {})
  assert.deepEqual(normalizeRealWindows({ 'zicode/deepseek-v4-pro': 800000 }), { 'zicode/deepseek-v4-pro': 800000 })
  // 取整，避免 800000.4 这种值让 pct 抖动
  assert.deepEqual(normalizeRealWindows({ 'a/m': 1000.6 }), { 'a/m': 1001 })
  // 光写 model 不安全：同型号不同线路容量不同，必须报错而不是猜
  assert.throws(() => normalizeRealWindows({ 'deepseek-v4-pro': 800000 }), /must be "provider\/model"/)
  assert.throws(() => normalizeRealWindows({ '/deepseek-v4-pro': 800000 }), /empty provider/)
  assert.throws(() => normalizeRealWindows({ 'zicode/': 800000 }), /empty model/)
  // model 自身带 '/' 是合法的（按第一个 '/' 切）
  assert.deepEqual(normalizeRealWindows({ 'openrouter/vendor/model-x': 200000 }), { 'openrouter/vendor/model-x': 200000 })
  assert.throws(() => normalizeRealWindows({ 'a/m': 0 }), /positive finite number/)
  assert.throws(() => normalizeRealWindows({ 'a/m': 0.4 }), /round to at least 1/)
  assert.throws(() => normalizeRealWindows({ 'a/m': -1 }), /positive finite number/)
  assert.throws(() => normalizeRealWindows({ 'a/m': '800000' }), /positive finite number/)
  assert.throws(() => normalizeRealWindows(['a/m']), /must be an object/)
  assert.throws(() => normalizeRealWindows(null), /must be an object/)
})

test('routeKey / windowOverrideOf: 按 provider/model 取覆盖值，互不串台', () => {
  assert.equal(routeKey('zicode', 'glm-5.3'), 'zicode/glm-5.3')
  assert.equal(routeKey('', 'glm-5.3'), '/glm-5.3')
  assert.equal(routeKey('p', ''), '', '没有 model 就没有路由键')

  const realWindows = { 'zicode/glm-5.3': 600000, 'zhipu-lite/glm-5.3': 1000000 }
  assert.equal(windowOverrideOf(realWindows, 'zicode', 'glm-5.3'), 600000)
  assert.equal(windowOverrideOf(realWindows, 'zhipu-lite', 'glm-5.3'), 1000000)
  assert.equal(windowOverrideOf(realWindows, 'unknown', 'glm-5.3'), null, '没配的线路退回标称值')
  assert.equal(windowOverrideOf(realWindows, 'zicode', ''), null)
  // 原型链键不能命中：键是 provider/model，所以原型名也被 '/' 前缀隔离
  for (const key of ['toString', 'constructor', '__proto__']) {
    assert.equal(windowOverrideOf({ [`/${key}`]: 1 }, '', key), 1, `真实键 /${key} 应命中`)
    assert.equal(windowOverrideOf({}, '', key), null, `空表不该命中 ${key}`)
  }
})

test('windowFields: 实测覆盖值收窄窗口、接管 windowSource', () => {
  const realWindows = { 'zicode/glm-5.3': 600000 }
  // 同型号两条线路：只有配置过的那条被收窄
  const zi = windowFields('glm-5.3', 1000000, 'zicode', realWindows)
  assert.deepEqual(zi, {
    window: 600000,
    declaredWindow: 1000000,
    realWindow: 600000,
    windowInflated: true,
    windowSource: 'override',
    routeKey: 'zicode/glm-5.3',
  })
  const zhipu = windowFields('glm-5.3', 1000000, 'zhipu-lite', realWindows)
  assert.equal(zhipu.window, 131072, '未配置的线路仍按标称收窄（131,072 < 1,000,000）')
  assert.equal(zhipu.windowSource, 'nominal')
  assert.equal(zhipu.windowInflated, true)

  // 覆盖值大于声明时，声明仍然生效（配置不是放大器）
  const small = windowFields('glm-5.3', 100000, 'zicode', realWindows)
  assert.equal(small.window, 100000)
  assert.equal(small.windowInflated, false, '声明没超过实测上限，不算虚高')
})

test('context_pressure: 配置实测覆盖后 pct 按实测窗口算', async () => {
  const ctx = { tokenMeter: { measure() { return { totalTokens: 540000, surfaceTokens: 1 } } } }
  const tool = pressureTool(ctx, { realWindows: { 'zicode/glm-5.3': 600000 } })
  const out = await tool.execute(
    {},
    { agent: { session: { requestContext: () => ({ contextWindow: 1000000, provider: 'zicode', model: 'glm-5.3' }) } } },
  )
  assert.equal(out.window, 600000, '声明 1M 但实测只有 600k：有效窗口按实测')
  assert.equal(out.windowSource, 'override')
  assert.equal(out.windowInflated, true)
  assert.equal(out.routeKey, 'zicode/glm-5.3')
  assert.equal(out.pct, 90)
})

test('context_pressure: 未配置时 windowSource=nominal，不假装已实测', async () => {
  const ctx = { tokenMeter: { measure() { return { totalTokens: 100, surfaceTokens: 1 } } } }
  const out = await pressureTool(ctx, {}).execute(
    {},
    { agent: { session: { requestContext: () => ({ contextWindow: 1048576, provider: 'x', model: 'deepseek-flash' }) } } },
  )
  assert.equal(out.windowSource, 'nominal')
  assert.equal(out.routeKey, 'x/deepseek-flash')
})

test('context_pressure: 空路由时 windowSource=unknown 且不炸', async () => {
  const ctx = { tokenMeter: { measure() { return { totalTokens: 100, surfaceTokens: 1 } } } }
  const out = await pressureTool(ctx, {}).execute({}, { agent: { session: { requestContext: () => ({}) } } })
  assert.equal(out.windowSource, 'unknown')
  assert.equal(out.window, null)
  assert.equal(out.routeKey, '')
  assert.equal(out.pct, null)
})

test('context_pressure: 实际返回的键必须在 schema 里（additionalProperties=false 会校验失败）', async () => {
  const ctx = { tokenMeter: { measure() { return { totalTokens: 500, surfaceTokens: 100 } } } }
  const tool = pressureTool(ctx)
  const declared = new Set(Object.keys(tool.output.schema.properties))
  const cases = [
    { session: { requestContext: () => ({ contextWindow: 131072, provider: 'p', model: 'glm-5.3' }) } },
    { session: { requestContext: () => ({}) } },
    {},
  ]
  for (const exec of cases) {
    const out = await tool.execute({}, exec)
    for (const key of Object.keys(out)) {
      assert.ok(declared.has(key), `返回了 schema 未声明的字段：${key}`)
    }
  }
})

test('技能文本写明窗口证据与实测覆盖，且不猜线路类型', () => {
  const d = DIAGNOSE_SKILL.content
  assert.ok(d.includes(WINDOW_EVIDENCE), '诊断要嵌窗口证据说明')
  assert.ok(d.includes('realWindows'), '诊断要告诉用户怎么填实测值')
  assert.ok(d.includes('400 Content Exists Risk'), '交班硬触发要含内容审核锁死')
  assert.ok(d.includes('网关 body 上限'), '告警要含网关体量上限')
  // 必须明确「不要推断线路类型」，且不能出现断言式的线路判定
  assert.ok(d.includes('不要推断 provider 是官方还是中转'), '要写明不得推断线路类型')
  assert.ok(d.includes('windowSource=nominal'), '标称窗口虚高要单独解释')
  assert.ok(d.includes('windowSource=override'), '实测安全值与声明窗口分支要单独解释')
  assert.ok(d.includes('宿主自动压缩仍按 X 算'), '要区分插件 pct 与宿主的声明窗口阈值')
  assert.doesNotMatch(d, /windowInflated=true → 「窗口虚高.*永不触发/, '不能对所有来源一概说宿主永不触发')
  assert.doesNotMatch(d, /你是中转|这是中转|判定为中转|属于中转/, '不能断言线路类型')
  assert.doesNotMatch(DECISION_SKILL.content, /你是中转|判定为中转/, '决策也不能断言线路类型')
  assert.ok(DECISION_SKILL.content.includes('算触发点'), '决策要说明自动压缩按声明窗口算')
  assert.ok(DECISION_SKILL.content.includes('declaredWindow'), '决策要点名声明窗口字段')
})

test('字段文案不得把标称值说成真实上限', () => {
  const d = pressureTool({}).output.schema.properties
  assert.doesNotMatch(d.realWindow.description, /真实上下文上限/)
  assert.doesNotMatch(d.window.description, /真实窗口/)
})
