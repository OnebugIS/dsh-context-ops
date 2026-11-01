/**
 * Client banner 行为测试。
 *
 * client.js 是浏览器侧自注册脚本（window.__ModuleLoader__.load），不能直接 import。
 * 这里用「最小 React 替身 + 可控时钟」把真实源码挂起来跑，断言的是行为
 * （弹 / 不弹 / 60 秒退出 / 档位往返），而不是源码里有没有某个字符串——
 * 正则断言删掉整段计时器也能过，那不算回归测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** 只实现 client.js 用到的三个 hook：useState / useRef / useEffect。 */
function createRuntime(startClock = 0) {
  const cells = []
  const effects = []
  const timers = new Map()
  let clock = startClock
  let nextTimerId = 1
  let cursor = 0
  let dirty = false

  const React = {
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
    }),
    useState(init) {
      const i = cursor++
      if (!(i in cells)) cells[i] = typeof init === 'function' ? init() : init
      return [
        cells[i],
        (next) => {
          const value = typeof next === 'function' ? next(cells[i]) : next
          if (value !== cells[i]) {
            cells[i] = value
            dirty = true
          }
        },
      ]
    },
    useRef(init) {
      const i = cursor++
      if (!(i in cells)) cells[i] = { current: init }
      return cells[i]
    },
    useEffect(fn, deps) {
      const i = cursor++
      const prev = effects[i]
      effects[i] = { fn, deps: deps === undefined ? null : [...deps], prevDeps: prev?.prevDeps, cleanup: prev?.cleanup, ran: prev?.ran === true }
    },
  }

  const sameDeps = (a, b) =>
    a === null || b === null ? false : a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  function commitEffects() {
    for (const slot of effects) {
      if (!slot) continue
      if (slot.ran && sameDeps(slot.deps, slot.prevDeps)) continue
      if (slot.cleanup) slot.cleanup()
      slot.prevDeps = slot.deps
      slot.ran = true
      const cleanup = slot.fn()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : null
    }
  }

  return {
    React,
    clock: () => clock,
    setTimeout(fn, ms) {
      const id = nextTimerId++
      timers.set(id, { fn, at: clock + ms })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    /** 推进假时钟并执行到期计时器，然后渲染到稳定。 */
    advance(ms) {
      clock += ms
      for (const [id, t] of [...timers]) {
        if (t.at > clock) continue
        timers.delete(id)
        t.fn()
      }
    },
    renderOnce(Banner, props) {
      let out
      for (let pass = 0; pass < 5; pass += 1) {
        cursor = 0
        dirty = false
        out = Banner(props)
        commitEffects()
        if (!dirty) return out
      }
      throw new Error('test React substitute did not settle')
    },
    isDirty: () => dirty,
    resetDirty: () => {
      dirty = false
    },
  }
}

/** 把 client.js 挂进替身环境，返回真正的 Banner 组件与 slot 注册信息。 */
function makeStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }
}

function mountBanner(sharedStorage = makeStorage(), startClock = 0) {
  const rt = createRuntime(startClock)
  const registered = []

  const fakeWindow = {
    localStorage: sharedStorage,
    __ModuleLoader__: {
      load: (mod) => {
        fakeWindow.__loaded = mod
      },
    },
  }
  const fakeRequire = (name) => {
    if (name === 'react') return rt.React
    throw new Error(`unexpected require: ${name}`)
  }

  // setTimeout / clearTimeout / Date 作为形参传入，遮蔽全局：计时器和 Date.now() 用同一个假时钟，
  // 否则「关闭期间过了截止时间」这类场景在测试里无法表达。
  new Function('window', 'setTimeout', 'clearTimeout', 'require', 'Date', SRC)(
    fakeWindow,
    rt.setTimeout,
    rt.clearTimeout,
    fakeRequire,
    { now: () => rt.clock() },
  )

  const mod = fakeWindow.__loaded
  assert.ok(mod, 'client.js 必须通过 window.__ModuleLoader__.load 注册')
  assert.equal(mod.id, 'dsh-context-ops')

  const plugin = mod.factory(fakeRequire)
  plugin.apply({
    slots: {
      inject: (name, cb) => cb(),
      register: (opts, Component) => {
        registered.push({ opts, Component })
        return () => {}
      },
    },
  })

  assert.equal(registered.length, 1)
  assert.equal(registered[0].opts.name, 'conversation.input.dock')

  const Banner = registered[0].Component
  let pressure = null
  let reminder = null
  let compaction = null
  let out = null

  const props = () => ({
    sessionId: 'session-under-test',
    useProjection: (key) => {
      if (key === 'contextPressure') return pressure
      if (key === 'contextOpsReminderConfig') return reminder
      if (key === 'contextOpsCompactionSignal') return compaction
      return undefined
    },
  })

  return {
    rt,
    /** 设定读数并渲染一帧（含 effect 提交）。 */
    set(pressureTokens, contextWindow, nextReminder = { enabled: true, remindAt: 60, handoffAt: 92 }, extraPressure = {}) {
      pressure = { ...extraPressure, pressureTokens, contextWindow }
      reminder = nextReminder
      rt.resetDirty()
      out = rt.renderOnce(Banner, props())
      return out
    },
    setCompaction(startCount) {
      compaction = { startCount }
      out = rt.renderOnce(Banner, props())
      return out
    },
    /** 只推进时间：计时器 setState 后重新渲染。 */
    advance(ms) {
      rt.advance(ms)
      out = rt.renderOnce(Banner, props())
      return out
    },
    current: () => out,
  }
}

/** 同一窗口下按百分比换算成 token。 */
const at = (pct) => (pct * 600000) / 100

test('banner: 过阈值弹出，60 秒后自动退出，持续高压不再重复弹', () => {
  const m = mountBanner()

  assert.ok(m.set(at(60), 600000), '到提醒阈值就该弹')
  assert.ok(m.advance(59000), '60 秒未到不得消失')
  assert.equal(m.advance(1000), null, '到点必须自动退出')
  assert.equal(m.advance(600000), null, '同一档位持续高压不再重复弹')
})

test('banner: 档位往返不会漏弹（升回交接档要重新弹出）', () => {
  const m = mountBanner()

  assert.ok(m.set(at(93), 600000), '交接档先弹')
  assert.equal(m.advance(60000), null, '60 秒后退出')

  assert.ok(m.set(at(70), 600000), '降档要重新弹')
  assert.ok(m.set(at(93), 600000), '10 秒内升回交接档：必须重新弹出（旧实现会吞掉）')
  assert.equal(m.advance(60000), null)
  assert.equal(m.set(at(93), 600000), null, '该档在本挂载内已隐藏，不重复弹')
})

test('banner: 组件重新挂载后沿用 session 的已隐藏状态', () => {
  const storage = makeStorage()
  const first = mountBanner(storage)

  assert.ok(first.set(at(93), 600000))
  assert.equal(first.advance(60000), null)

  const remounted = mountBanner(storage)
  assert.equal(remounted.set(at(93), 600000), null, '重新挂载不能把已经退出的 toast 再次显示')
})

test('banner: 关闭期间已过截止时间，重开不得重新计时', () => {
  const storage = makeStorage()
  const first = mountBanner(storage, 0)

  assert.ok(first.set(at(93), 600000), '第一次进入交接档先弹')
  assert.ok(first.advance(20000), '20 秒时还在显示')

  // 模拟关闭 App：20 秒后关掉，20 分钟后才重开（远超 60 秒截止时间）
  const later = mountBanner(storage, 20 * 60000)
  assert.equal(
    later.set(at(93), 600000),
    null,
    '截止时间在关闭期间已经过去，应视为已退出，不能又弹 60 秒',
  )
})

test('banner: 读数缺失不得被当成压力回落', () => {
  const m = mountBanner()

  assert.ok(m.set(at(93), 600000))
  assert.equal(m.advance(60000), null, '正常 60 秒退出')

  assert.equal(m.set(undefined, undefined), null, '投影还没加载 / 断线：不显示')
  assert.equal(
    m.set(at(93), 600000),
    null,
    '数据恢复后不能因为「刚才读不到」就把已退出的 toast 复活',
  )
})

test('banner: 优先用 projectedTokens（压缩后靠它先回落）', () => {
  const off = mountBanner()
  assert.equal(
    off.set(at(70), 600000, undefined, { projectedTokens: at(30) }),
    null,
    'projectedTokens 已低于阈值时不得按 pressureTokens 弹出',
  )
  assert.ok(
    off.set(at(30), 600000, undefined, { projectedTokens: at(70) }),
    'projectedTokens 越线时按它弹出',
  )

  const fallback = mountBanner()
  assert.ok(
    fallback.set(at(70), 600000, undefined, { projectedTokens: null }),
    'projectedTokens 非法时回退到 pressureTokens',
  )
  assert.ok(
    fallback.set(at(70), 600000, undefined, { projectedTokens: -1 }),
    'projectedTokens 为负同样回退',
  )
})

test('banner: compaction/start 到达后立即收起，不等 60 秒', () => {
  const m = mountBanner()

  assert.ok(m.set(at(70), 600000))
  assert.ok(m.setCompaction(0), '首次投影值只是基线，不能误收起')
  assert.equal(m.advance(1000) !== null, true)
  assert.equal(m.setCompaction(1), null, '新的压缩开始信号应立即收起 toast')
})

test('banner: 压缩造成降档时不立刻弹另一条提醒', () => {
  const m = mountBanner()

  assert.ok(m.set(at(93), 600000))
  assert.ok(m.setCompaction(0))
  assert.equal(m.setCompaction(1), null, '压缩开始先收起交接提醒')
  assert.equal(m.set(at(70), 600000), null, '压缩后从 handoff 降到 notice 不应换档重弹')
})

test('banner: 历史 compaction 计数初始化只作基线，后续递增才收起', () => {
  const m = mountBanner()

  assert.ok(m.set(at(70), 600000))
  assert.ok(m.setCompaction(7), '初始已存在的历史计数不应误收起')
  assert.equal(m.setCompaction(8), null, '计数递增才代表新的压缩开始')
})

test('banner: 回落到阈值以下重新武装', () => {
  const m = mountBanner()

  assert.ok(m.set(at(93), 600000))
  assert.equal(m.advance(60000), null)

  assert.equal(m.set(at(30), 600000), null, '阈值以下不显示')
  assert.ok(m.set(at(93), 600000), '重新越线要再弹一次')
})

test('banner: 配置关闭 / 读数缺失时不渲染', () => {
  const m = mountBanner()

  assert.equal(m.set(at(93), 600000, { enabled: false, remindAt: 60, handoffAt: 92 }), null)
  assert.equal(m.set(at(93), 0), null, '窗口为 0 不得算出 Infinity')
  assert.equal(m.set(at(93), undefined), null)
})

test('banner: 文案是短提示，且定位在右上角', () => {
  const m = mountBanner()
  const vnode = m.set(at(93), 600000)

  assert.equal(vnode.props.children, '上下文已达 92%，建议立即交接')
  assert.equal(vnode.props.style.position, 'fixed')
  assert.equal(vnode.props.style.top, '12px')
  assert.equal(vnode.props.style.right, '12px')
  assert.equal(vnode.props.style.pointerEvents, 'none')
})
