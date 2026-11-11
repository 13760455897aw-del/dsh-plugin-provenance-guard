/**
 * 来源审计 / Provenance Guard — browser half.
 *
 * A single header chip that opens the session's ledger: how many searches were
 * audited, what each one collapsed to (K/N), the warrant grade, and whether any
 * generator was found. The data comes from the host route
 * `GET /provenance-guard/ledger?session=<id>`; this module never touches the
 * session log, the DOM outside its own slot, or another plugin's state.
 *
 * Plain browser bundle: `window.__ModuleLoader__` is the host's module table,
 * and `require('react')` resolves from it. Nothing here may throw at load —
 * a throwing entry blanks its slot.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-provenance-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // `react-dom` is part of the host module table (the shipped UI bundles use
    // it); a profile without it degrades to rendering the card in place.
    let createPortal = null
    try {
      const ReactDOM = require('react-dom')
      createPortal = ReactDOM && typeof ReactDOM.createPortal === 'function'
        ? ReactDOM.createPortal
        : null
    } catch {
      createPortal = null
    }

    const ROUTE = '/provenance-guard/ledger'
    const POLL_MS = 5000
    const MAX_ROWS = 10

    const GRADE_INK = { A: '#1f7a4d', B: '#1a56db', C: '#b45309', D: '#b91c1c' }
    const LEVEL_TEXT = { silent: '闭嘴', brief: '简条', full: '全条' }

    const INK = 'var(--dsw-alias-label-primary, #1f2328)'
    const INK_MUTED = 'var(--dsw-alias-label-tertiary, #6b7280)'
    const BG = 'var(--dsw-alias-bg-base, #ffffff)'
    const BORDER = 'var(--dsw-alias-border-l2, rgba(0,0,0,.14))'

    /** `MM-DD HH:MM`, local; the ledger spans restarts and days. */
    function stamp(at) {
      const date = new Date(Number(at) || 0)
      if (Number.isNaN(date.getTime()) || date.getTime() === 0) return ''
      const pad = value => (value < 10 ? '0' : '') + String(value)
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function badge(text, color) {
      return h('span', {
        style: {
          display: 'inline-block',
          padding: '0 4px',
          borderRadius: 2,
          background: color,
          color: '#fff',
          fontSize: 10,
          fontWeight: 700,
          lineHeight: '14px',
        },
      }, text)
    }

    function Row({ query }) {
      const ink = GRADE_INK[query.grade] || INK_MUTED
      const meta = [
        `n=${query.n}`,
        `K=${query.k}`,
        query.siteCount ? `${query.siteCount} 站点` : '',
        query.platformCount ? `${query.platformCount} 自媒体` : '',
      ].filter(part => part.length > 0).join(' · ')
      return h('div', {
        style: {
          padding: '6px 0',
          borderTop: `1px dashed ${BORDER}`,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        },
      }, [
        h('div', {
          key: 'line',
          style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: INK },
        }, [
          h('span', { key: 'time', style: { color: INK_MUTED, fontVariantNumeric: 'tabular-nums' } }, stamp(query.at)),
          badge(`${query.grade} 级`, ink),
          h('span', { key: 'meta', style: { color: INK_MUTED } }, meta),
          h('span', { key: 'level', style: { marginLeft: 'auto', color: INK_MUTED, fontSize: 11 } },
            LEVEL_TEXT[query.level] || query.level),
        ]),
        (query.claim || query.originSite)
          ? h('div', { key: 'claim', style: { fontSize: 11, color: INK_MUTED } },
            [
              query.claim ? `主张 ${query.claim}` : '',
              query.originSite ? `最早 ${query.originSite}` : '',
              query.echoes ? `${query.echoes} 条转述` : '',
            ].filter(part => part.length > 0).join(' · '))
          : null,
        query.primarySites && query.primarySites.length > 0
          ? h('div', { key: 'primary', style: { fontSize: 11, color: INK_MUTED } },
            `一手源：${query.primarySites.join('、')}`)
          : null,
      ])
    }

    function Card({ data }) {
      const totals = (data && data.totals) || { searches: 0, sources: 0, sites: 0 }
      const queries = Array.isArray(data && data.queries) ? data.queries.slice(-MAX_ROWS) : []
      const options = (data && data.options) || {}

      const children = [
        h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'baseline', gap: 8 },
        }, [
          h('span', { key: 'title', style: { fontSize: 13, fontWeight: 700, color: INK } }, '来源台账'),
          h('span', { key: 'totals', style: { fontSize: 11, color: INK_MUTED } },
            `${totals.searches} 次检索 / ${totals.sources} 条结果 / ${totals.sites} 个站点`),
        ]),
      ]

      if (queries.length === 0) {
        children.push(h('div', { key: 'empty', style: { marginTop: 8, fontSize: 12, color: INK_MUTED } },
          '本会话还没有经过审计的检索。'))
      } else {
        children.push(h('div', { key: 'rows', style: { marginTop: 6 } },
          queries.slice().reverse().map((query, index) => h(Row, { key: `q-${index}`, query }))))
      }

      children.push(h('div', {
        key: 'foot',
        style: { marginTop: 8, paddingTop: 6, borderTop: `1px solid ${BORDER}`, fontSize: 11, color: INK_MUTED },
      }, [
        h('div', { key: 'flags' },
          `minSources=${options.minSources ?? '-'} · verify=${String(options.verify)}`
          + ` · async=${String(options.asyncVerify)} · maxProbes=${options.maxProbes ?? '-'}`),
        options.configFile
          ? h('div', { key: 'file', style: { marginTop: 2, wordBreak: 'break-all' } }, `配置：${options.configFile}`)
          : null,
      ]))

      return h('div', {
        style: {
          position: 'fixed',
          top: 64,
          right: 24,
          width: 440,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: 'calc(100vh - 96px)',
          overflowY: 'auto',
          padding: '10px 12px',
          borderRadius: 8,
          background: BG,
          border: `1px solid ${BORDER}`,
          boxShadow: '0 10px 28px rgba(0,0,0,.22)',
          color: INK,
          zIndex: 9999,
        },
      }, children)
    }

    /**
     * The chip.
     *
     * It checks the host route on mount, not only on click: a disabled plugin
     * takes its host half away while this bundle can already be live in the
     * page, and a chip whose route is gone must disappear rather than sit there
     * reporting a load failure. Any failed read hides it; a later successful
     * poll brings it back.
     */
    function LedgerChip({ sessionId }) {
      const [open, setOpen] = React.useState(false)
      const [data, setData] = React.useState(null)
      const [off, setOff] = React.useState(false)

      React.useEffect(() => {
        let cancelled = false
        const load = () => {
          try {
            fetch(`${ROUTE}?session=${encodeURIComponent(sessionId)}`, {
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
              .then(response => (response.ok ? response.json() : null))
              .then(json => {
                if (cancelled) return
                if (json && json.totals) {
                  setData(json)
                  setOff(false)
                } else {
                  setOff(true)
                }
              })
              .catch(() => {
                if (!cancelled) setOff(true)
              })
          } catch {
            if (!cancelled) setOff(true)
          }
        }
        // Mount check: the host half may never have been loaded this session.
        load()
        if (!open) return () => {
          cancelled = true
        }
        const timer = setInterval(load, POLL_MS)
        return () => {
          cancelled = true
          clearInterval(timer)
        }
      }, [open, sessionId])

      // The host is gone (disabled, unloaded, or not installed): show nothing.
      if (off) return null

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = event => {
          if (event && event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const count = data && data.totals ? data.totals.searches : null

      const chip = h('button', {
        type: 'button',
        onClick: () => setOpen(value => !value),
        title: '来源审计：本会话的检索台账',
        'aria-expanded': open ? 'true' : 'false',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 24,
          padding: '0 9px',
          marginLeft: 6,
          borderRadius: 4,
          border: `1px solid ${BORDER}`,
          background: 'transparent',
          color: INK,
          font: 'inherit',
          fontSize: 11,
          lineHeight: '22px',
          cursor: 'pointer',
          flex: '0 0 auto',
          whiteSpace: 'nowrap',
        },
      }, [
        h('span', { key: 'dot', style: { width: 6, height: 6, borderRadius: 3, background: '#b45309' } }),
        h('span', { key: 'label' }, '来源台账'),
        count !== null
          ? h('span', { key: 'count', style: { color: INK_MUTED } }, String(count))
          : null,
      ])

      if (!open) return chip

      // The chip lives inside the conversation header, which sits in its own
      // stacking context: a fixed-position card drawn there ends up behind the
      // right sidebar. Portal the overlay to `document.body` so it competes at
      // the page root, and keep a very high z-index for the same reason.
      const overlay = [
        h('div', {
          key: 'backdrop',
          onClick: () => setOpen(false),
          style: { position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 9998 },
        }),
        h(Card, { key: 'card', data }),
      ]

      let rendered = overlay
      if (typeof createPortal === 'function' && typeof document !== 'undefined' && document.body) {
        try {
          rendered = createPortal(h(React.Fragment, null, overlay), document.body)
        } catch {
          rendered = overlay
        }
      }

      return h(React.Fragment, null, chip, rendered)
    }

    return {
      inject: ['slots'],

      apply(ctx) {
        const register = () => {
          try {
            ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
              name: 'conversation.session.header.actions',
              id: 'provenance-guard',
              order: 60,
              inject: sessionId => ({ sessionId }),
            }, props => {
              // Session-scoped slots inject the session id as the first
              // argument (same contract the shipped UI packages use). Accept a
              // handle shape too, so a contract drift degrades to "no chip"
              // rather than to a chip reading someone else's ledger.
              const raw = props.sessionId ?? (props.session && props.session.id) ?? null
              const sessionId = typeof raw === 'string'
                ? raw
                : (raw && typeof raw.id === 'string' ? raw.id : null)
              if (sessionId === null) return null
              return h(LedgerChip, { sessionId })
            }))
          } catch (error) {
            console.warn('[provenance-guard] slot registration skipped:', error)
          }
        }
        // One task later the slot owners have declared their slots; registering
        // before that is what silently drops entries.
        try {
          setTimeout(register, 0)
        } catch {
          register()
        }
      },
    }
  },
})
