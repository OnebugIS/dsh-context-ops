window.__ModuleLoader__.load({
  id: 'dsh-context-ops',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // 右上角短提示：最多展示 HIDE_AFTER_MS，超时自动退出。
    // 隐藏状态按 sessionId + 档位存 localStorage，组件重挂载 / DeskApp 重启后不重新计时。
    const HIDE_AFTER_MS = 60000
    const STORAGE_PREFIX = 'dsh-context-ops:toast:'
    const BANDS = ['notice', 'handoff']
    const BAND_RANK = { notice: 1, handoff: 2 }

    function finiteNonNegative(value) {
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
    }

    /**
     * 用哪个数字算占用：优先宿主自己维护的 projectedTokens
     * （= 下一次请求的估算占用，压缩后会先回落），缺失或非法时回退到 pressureTokens
     * （= 上一次请求的输入侧实测）。宿主自带的上下文指示器也是这个优先级。
     */
    function usedTokens(pressure) {
      const projected = finiteNonNegative(pressure?.projectedTokens)
      return projected !== null ? projected : finiteNonNegative(pressure?.pressureTokens)
    }

    /**
     * 四态取值。不能只用「显示 / 不显示」两态：
     *   'disabled' 配置关闭            'unknown' 读数不可用（投影未加载 / 字段非法）
     *   'low'      有效读数且低于阈值   'notice' / 'handoff' 各档
     * 只有 'low' 与 'disabled' 才算「压力确实回落」。'unknown' 绝不能清状态，
     * 否则一次断线或投影延迟就会把已经退出的提醒复活。
     */
    function bandOf(pressure, reminder) {
      if (!reminder) return 'unknown'
      if (reminder.enabled !== true) return 'disabled'
      if (typeof reminder.remindAt !== 'number' || typeof reminder.handoffAt !== 'number') return 'unknown'
      const windowTokens = finiteNonNegative(pressure?.contextWindow)
      const used = usedTokens(pressure)
      if (windowTokens === null || windowTokens <= 0 || used === null) return 'unknown'
      const pct = (used / windowTokens) * 100
      if (pct >= reminder.handoffAt) return 'handoff'
      if (pct >= reminder.remindAt) return 'notice'
      return 'low'
    }

    function storageFor(windowObject) {
      try { return windowObject.localStorage } catch { return null }
    }

    function storageKey(sessionId) {
      return `${STORAGE_PREFIX}${sessionId}`
    }

    function startCountOf(signal) {
      return finiteNonNegative(signal?.startCount)
    }

    function readToastState(storage, key) {
      if (!storage || key === '') return null
      try {
        const value = JSON.parse(storage.getItem(key) || 'null')
        return value && typeof value === 'object' ? value : null
      } catch { return null }
    }

    function writeToastState(storage, key, value) {
      if (!storage || key === '') return
      try { storage.setItem(key, JSON.stringify(value)) } catch { /* storage unavailable */ }
    }

    function removeToastState(storage, key) {
      if (!storage || key === '') return
      try { storage.removeItem(key) } catch { /* storage unavailable */ }
    }

    /**
     * 这条提醒是否已经不需要再显示。
     * 注意「已过截止时间」也要算已退出 —— 否则关闭 App 期间把 60 秒走完了，
     * 重开还会从头再弹一次（这正是之前报的那个 bug 的另一种复现路径）。
     */
    function isDismissed(record) {
      if (!record) return false
      if (record.hidden === true) return true
      return typeof record.expiresAt === 'number' && record.expiresAt <= Date.now()
    }

    function Banner({ sessionId, useProjection }) {
      const pressure = useProjection('contextPressure')
      const reminder = useProjection('contextOpsReminderConfig')
      const compaction = useProjection('contextOpsCompactionSignal')

      const status = bandOf(pressure, reminder)
      const level = status === 'notice' || status === 'handoff' ? status : ''
      const starts = startCountOf(compaction)
      const storage = storageFor(window)
      const key = storageKey(sessionId)
      const [hidden, setHidden] = React.useState(() => isDismissed(readToastState(storage, key)))
      const previousStatus = React.useRef(status)
      const mounted = React.useRef(false)

      React.useEffect(() => {
        const forget = () => removeToastState(storage, key)

        // 配置关闭 / 有效读数确实低于阈值：清记录，下次越线重新提示。
        if (status === 'disabled' || status === 'low') {
          forget()
          previousStatus.current = status
          setHidden(false)
          return
        }

        // 读数不可用：保持现状。既不当成压力回落，也不重新计时。
        if (status === 'unknown') return

        const current = readToastState(storage, key)
        const sameBand = current?.band === level
        let baselineStart = typeof current?.baselineStart === 'number' ? current.baselineStart : null
        if (sameBand && baselineStart === null && starts !== null) baselineStart = starts

        // compaction/start 在这条提醒出现之后到达：立即收起，不等 60 秒。
        const compactedSinceShown = sameBand && starts !== null && baselineStart !== null && starts > baselineStart
        if (compactedSinceShown) {
          writeToastState(storage, key, { ...current, band: level, baselineStart, hidden: true })
          setHidden(true)
          return
        }

        // 压缩造成的降档不再立即弹出另一条 toast；等真正回落后重新武装。
        const downgradedAfterCompaction = current && !sameBand
          && BAND_RANK[level] < BAND_RANK[current.band]
          && starts !== null && typeof current.baselineStart === 'number'
          && starts > current.baselineStart
        if (downgradedAfterCompaction) {
          writeToastState(storage, key, { ...current, band: level, baselineStart: starts, hidden: true })
          setHidden(true)
          return
        }

        // 档位一变（升档 / 非压缩降档）就重新武装：清掉旧记录，重新弹一次。
        if (mounted.current && previousStatus.current !== status) {
          removeToastState(storage, key)
          setHidden(false)
        }
        previousStatus.current = status
        mounted.current = true

        const next = readToastState(storage, key)
        if (isDismissed(next)) {
          if (next?.hidden !== true) writeToastState(storage, key, { ...next, hidden: true })
          setHidden(true)
          return
        }

        const expiresAt = typeof next?.expiresAt === 'number' ? next.expiresAt : Date.now() + HIDE_AFTER_MS
        writeToastState(storage, key, { ...next, band: level, expiresAt, baselineStart, hidden: false })
        setHidden(false)
        const timer = setTimeout(() => {
          writeToastState(storage, key, { ...readToastState(storage, key), band: level, expiresAt, baselineStart, hidden: true })
          setHidden(true)
        }, Math.max(0, expiresAt - Date.now()))
        return () => clearTimeout(timer)
      }, [status, level, key, sessionId, starts])

      if (level === '' || hidden) return null

      const isHandoff = level === 'handoff'
      const text = isHandoff
        ? `上下文已达 ${reminder.handoffAt}%，建议立即交接`
        : `上下文已达 ${reminder.remindAt}%，建议 /compact`

      return h('div', {
        role: 'status',
        'aria-live': isHandoff ? 'assertive' : 'polite',
        'data-context-ops-banner': level,
        'data-session-id': sessionId,
        style: {
          position: 'fixed',
          top: '12px',
          right: '12px',
          zIndex: 9999,
          maxWidth: '320px',
          padding: '6px 12px',
          borderRadius: '8px',
          pointerEvents: 'none',
          border: isHandoff
            ? '1px solid var(--dsw-alias-danger-border, #d66)'
            : '1px solid var(--dsw-alias-warning-border, #d6a23c)',
          background: isHandoff
            ? 'var(--dsw-alias-danger-bg, rgba(180,50,50,.92))'
            : 'var(--dsw-alias-warning-bg, rgba(214,162,60,.92))',
          color: 'var(--dsw-alias-text-primary, inherit)',
          fontSize: '12px',
          lineHeight: 1.4,
          boxShadow: '0 2px 8px rgba(0,0,0,.15)',
        },
      }, text)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'context-ops-banner',
          order: 20,
        }, Banner))
      },
    }
  },
})
