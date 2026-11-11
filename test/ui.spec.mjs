import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

import { apply } from '../index.js'

// Keep the route's diagnostic write out of the user's real state directory.
const testHome = join(tmpdir(), `provenance-guard-home-${randomUUID()}`)
process.env.DSH_HOME = testHome
process.on('exit', () => {
  try {
    rmSync(testHome, { recursive: true, force: true })
  } catch {
    /* never created */
  }
})

let passed = 0
function ok(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log('  PASS  ' + label)
  } else {
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' :: ' + JSON.stringify(detail)))
    process.exitCode = 1
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

// ---------------------------------------------------------------------------
console.log('\n== host route: ledger JSON ==')
{
  const routes = []
  const effects = []
  const ctx = {
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
    inject(names, callback) {
      ok('route waits for webServer', Array.isArray(names) && names.includes('webServer'), names)
      callback({
        webServer: {
          register(definition) {
            routes.push(definition)
            return () => {}
          },
        },
        effect(fn) {
          effects.push(fn)
        },
      })
    },
  }
  apply(ctx, { minSources: 3, verify: false })

  ok('route registered', routes.length === 1 && routes[0].path === '/provenance-guard/ledger', routes.map(route => route.path))
  ok('route is exact', routes[0].kind === 'exact', routes[0].kind)

  const respond = () => {
    const state = { status: 0, headers: null, body: '' }
    const res = {
      writeHead(status, headers) {
        state.status = status
        state.headers = headers
      },
      end(body) {
        state.body = String(body)
      },
    }
    return { state, res }
  }

  const empty = respond()
  routes[0].handler({ url: '/provenance-guard/ledger?session=session-route' }, empty.res)
  const emptyView = JSON.parse(empty.state.body)
  ok('empty ledger is describable', emptyView.totals.searches === 0, emptyView.totals)
  ok('view names the session', emptyView.sessionId === 'session-route', emptyView.sessionId)
  ok('view carries the effective config', emptyView.options.minSources === 3, emptyView.options)
  ok('json content type', /application\/json/.test(String(empty.state.headers?.['content-type'])), empty.state.headers)

  // Missing session param is not an error: the chip may mount before the id.
  const noSession = respond()
  routes[0].handler({ url: '/provenance-guard/ledger' }, noSession.res)
  const noSessionView = JSON.parse(noSession.state.body)
  ok('missing session yields an empty view', noSessionView.sessionId === '' && noSessionView.totals.searches === 0, noSessionView)

  // A broken request must answer 500 rather than throw into the server.
  const broken = respond()
  routes[0].handler({ get url() { throw new Error('boom') } }, broken.res)
  ok('route failure becomes a 500', broken.state.status === 500 && /boom/.test(broken.state.body), broken.state)

  ok('route disposer is owned by an effect', effects.length === 1 && typeof effects[0] === 'function')
  effects[0]()
}

// A host without webServer (or without ctx.inject) must still load.
{
  const ctx = {
    on() {
      return () => {}
    },
    get() {
      return undefined
    },
  }
  let threw = false
  try {
    apply(ctx, {})
  } catch {
    threw = true
  }
  ok('apply tolerates a host without webServer', threw === false)
}

// ---------------------------------------------------------------------------
console.log('\n== browser bundle: slot entry ==')
{
  let definition = null
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        definition = value
      },
    },
  }
  await import('../lib/client.js')

  ok('client registers under the package id', definition !== null && definition.id === 'dsh-plugin-provenance-guard', definition && definition.id)

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {},
    Fragment: 'Fragment',
  }

  const module = definition.factory(() => React)
  ok('client injects slots', Array.isArray(module.inject) && module.inject.includes('slots'), module.inject)

  const entries = []
  const ctx = {
    slots: {
      inject(name, callback) {
        ok('slot target exists in the conversation header', name === 'conversation.session.header.actions', name)
        callback()
      },
      register(options, component) {
        entries.push({ options, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)
  await tick()

  ok('one slot entry registered', entries.length === 1, entries.length)
  ok('entry key is stable', entries[0].options.id === 'provenance-guard', entries[0].options.id)
  ok('entry injects the session id', entries[0].options.inject('session-ui').sessionId === 'session-ui')

  const element = entries[0].component({ sessionId: 'session-ui' })
  ok('entry renders a component', element !== null && typeof element.type === 'function', element && element.type)

  const chip = element.type({ sessionId: 'session-ui' })
  ok('chip renders a button', chip !== null && chip.type === 'button', chip && chip.type)
  ok('chip has a click handler', typeof chip.props.onClick === 'function')
  ok('chip is labelled', JSON.stringify(chip.children).includes('来源台账'), chip.children)

  const nothing = entries[0].component({})
  ok('no session means no chip', nothing === null, nothing)

  // --- open state: the card must escape the header's stacking context -------
  {
    globalThis.document = { body: { tag: 'body' } }
    const portals = []
    const ReactDOM = {
      createPortal(node, target) {
        portals.push({ node, target })
        return node
      },
    }
    let hooked = 0
    const ReactOpen = {
      createElement: React.createElement,
      Fragment: 'Fragment',
      useEffect() {},
      useState(initial) {
        hooked += 1
        // First hook is `open`; the rest keep their initial values.
        if (hooked === 1) return [true, () => {}]
        return [typeof initial === 'function' ? initial() : initial, () => {}]
      },
    }
    const opened = definition.factory(name => (name === 'react-dom' ? ReactDOM : ReactOpen))
    const openEntries = []
    opened.apply({
      slots: {
        inject(_name, callback) {
          callback()
        },
        register(options, component) {
          openEntries.push({ options, component })
          return () => {}
        },
      },
    })
    await tick()
    const openElement = openEntries[0].component({ sessionId: 'session-ui' })
    const tree = openElement.type({ sessionId: 'session-ui' })
    ok('open state portals the overlay to document.body', portals.length === 1 && portals[0].target === globalThis.document.body, portals.length)
    ok('open tree keeps the chip mounted', JSON.stringify(tree.children[0]).includes('来源台账'), tree.children.length)
    delete globalThis.document
  }
}

console.log(`\n${passed} checks passed\n`)
