import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LADDER, HARD_RULE, FAILURE_ATTRIBUTION, REAL_WINDOWS } from '../lib/policy.js'
import { HANDOFF_SKILL } from '../lib/skills/handoff.js'
import { DECISION_SKILL } from '../lib/skills/decision.js'
import { DIAGNOSE_SKILL } from '../lib/skills/diagnose.js'
import { pressureTool, resolveConfig } from '../lib/index.js'

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

test('resolveConfig: 默认全开，未知键报错', () => {
  assert.deepEqual(resolveConfig(), { enablePressureTool: true, enableCommands: true })
  assert.deepEqual(resolveConfig({ enablePressureTool: false }), {
    enablePressureTool: false,
    enableCommands: true,
  })
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown config key/)
})

test('context_pressure: 无 agent 时返回空值', async () => {
  const tool = pressureTool({})
  const out = await tool.execute({}, {})
  assert.equal(out.pressureTokens, 0)
  assert.equal(out.window, null)
  assert.equal(out.note, '')
})

test('context_pressure: measure 抛错时兜底', async () => {
  const ctx = { tokenMeter: { measure() { throw new Error('boom') } } }
  const tool = pressureTool(ctx)
  const out = await tool.execute({}, { agent: { session: {} } })
  assert.equal(out.pressureTokens, 0)
  assert.match(out.note, /boom/)
})
