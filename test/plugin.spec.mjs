import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, settleProbes } from '../index.js'

// Keep every test write out of the real $DSH_HOME ledger.
const testLedger = join(tmpdir(), `provenance-guard-ledger-${randomUUID()}.json`)
process.env.DSH_PROVENANCE_LEDGER = testLedger
process.on('exit', () => {
  try {
    rmSync(testLedger, { force: true })
  } catch {
    /* the file may never have been created */
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

/** Minimal Cordis context double that records what the plugin registers. */
function fakeContext() {
  const registrations = []
  const ctx = {
    on(event, listener) {
      registrations.push({ event, listener })
      return () => {}
    },
  }
  return { ctx, registrations }
}

function decisionWith(text) {
  return { kind: 'accept', content: [{ type: 'text', text }] }
}

function makeSources(count) {
  const list = []
  for (let i = 0; i < count; i += 1) {
    list.push({
      url: `https://farm${i}-news.com/a/${i}`,
      title: '某产业占全球 73.6% 份额 稳居第一',
      snippet: '有数据显示，某产业已占全球 73.6% 的份额，稳居第一位。',
      publishedAt: '2026-10-28T09:00:00Z',
    })
  }
  return list
}

const { ctx, registrations } = fakeContext()
apply(ctx, { verify: true, minSources: 3 })

ok('registers exactly one hook', registrations.length === 1, registrations.length)
ok('hook is tools/post-execute', registrations[0].event === 'tools/post-execute', registrations[0].event)

const listener = registrations[0].listener
const original = 'ORIGINAL RESULT BODY'
const next = async () => decisionWith(original)

// 1. web_search with a poisoned-looking set must be annotated.
{
  const result = { isError: false, value: { sources: makeSources(6), truncated: false }, content: [{ type: 'text', text: original }] }
  const out = await listener({ name: 'web_search', agent: { id: 'session-a' } }, result, next)
  ok('keeps decision kind', out.kind === 'accept', out.kind)
  ok('prepends an audit block', out.content.length === 2, out.content.length)
  ok('audit block mentions K', /K=\d+/.test(out.content[0].text), out.content[0].text)
  ok('original content preserved last', out.content[1].text === original)
  console.log('\n--- annotated output ---\n' + out.content[0].text + '\n------------------------\n')
}

// 2. Other tools pass through untouched.
{
  const result = { isError: false, value: { sources: makeSources(6) }, content: [{ type: 'text', text: original }] }
  const out = await listener({ name: 'web_fetch', agent: { id: 'session-a' } }, result, next)
  ok('web_fetch untouched', out.content.length === 1 && out.content[0].text === original)
}

// 3. A failed call passes through untouched.
{
  const result = { isError: true, error: { message: 'boom' }, content: [{ type: 'text', text: original }] }
  const out = await listener({ name: 'web_search', agent: { id: 'session-a' } }, result, next)
  ok('error result untouched', out.content.length === 1)
}

// 4. Too few sources stays silent.
{
  const result = { isError: false, value: { sources: makeSources(2) }, content: [{ type: 'text', text: original }] }
  const out = await listener({ name: 'web_search', agent: { id: 'session-a' } }, result, next)
  ok('silent under minSources', out.content.length === 1 && out.content[0].text === original)
}

// 5. A healthy set stays silent.
{
  const sources = [
    { url: 'https://www.stats.gov.cn/a', title: '三季度行业运行情况', snippet: '国家统计局发布三季度数据。' },
    { url: 'https://www.reuters.com/a', title: 'Industry output rises', snippet: 'Output climbed in the third quarter.' },
    { url: 'https://www.caixin.com/a', title: '三季度数据发布', snippet: '统计局公布最新数据。' },
    { url: 'https://www.yicai.com/a', title: '成绩单出炉', snippet: '行业运行总体平稳。' },
  ]
  const result = { isError: false, value: { sources }, content: [{ type: 'text', text: original }] }
  const out = await listener({ name: 'web_search', agent: { id: 'session-b' } }, result, next)
  ok('silent on healthy set', out.content.length === 1 && out.content[0].text === original)
}

// 6. A blocked decision is never resurrected.
{
  const result = { isError: false, value: { sources: makeSources(6) }, content: [] }
  const blocked = await listener({ name: 'web_search', agent: { id: 'session-a' } }, result, async () => ({ kind: 'block', feedback: [] }))
  ok('block decision preserved', blocked.kind === 'block', blocked.kind)
}

// 7. Session memory: the same title from a second site is reported on a later search.
{
  const second = [
    { url: 'https://other-site.com/x', title: '某产业占全球 73.6% 份额 稳居第一', snippet: '有数据显示，某产业已占全球 73.6% 的份额。' },
    { url: 'https://third-site.com/y', title: '另一条完全不同的新闻标题在这里', snippet: '内容不相关。' },
    { url: 'https://fourth-site.com/z', title: '再一条不同主题的报道标题', snippet: '另一件不相关的事。' },
  ]
  const result = { isError: false, value: { sources: second }, content: [{ type: 'text', text: original }] }
  const out = await listener({ name: 'web_search', agent: { id: 'session-a' } }, result, next)
  const text = out.content.length > 1 ? out.content[0].text : ''
  ok('cross-search repeat surfaced', text.includes('复现') || text.includes('谱系'), text)
}

// 8. A throwing downstream listener never breaks the pipeline.
{
  const result = { isError: false, value: { sources: makeSources(6) }, content: [{ type: 'text', text: original }] }
  const out = await listener(
    { name: 'web_search', agent: { id: 'session-c' } },
    result,
    async () => { throw new Error('downstream exploded') },
  ).catch(error => ({ caught: String(error) }))
  ok('downstream throw propagates cleanly', typeof out.caught === 'string', out)
}

// ---------------------------------------------------------------------------
// v2 verification (L1 page probe / L2 fingerprint search)
// ---------------------------------------------------------------------------

function poisonedSet() {
  return [
    { url: 'https://a-news.com/1', title: '某产业占全球73.6%份额 稳居第一', snippet: '有数据显示73.6%。', publishedAt: '2026-10-28T02:00:00Z' },
    { url: 'https://b-daily.com/2', title: '某产业占全球73.6%份额 再创新高', snippet: '有数据显示73.6%。', publishedAt: '2026-10-28T04:00:00Z' },
    { url: 'https://c-post.com/3', title: '某产业占全球73.6%份额 引发关注', snippet: '有数据显示73.6%。', publishedAt: '2026-10-28T06:00:00Z' },
    { url: 'https://d-times.com/4', title: '某产业占全球73.6%份额 专家解读', snippet: '有数据显示73.6%。', publishedAt: '2026-10-29T02:00:00Z' },
    { url: 'https://e-review.com/5', title: '某产业占全球73.6%份额 值得警惕', snippet: '有数据显示73.6%。', publishedAt: '2026-10-29T04:00:00Z' },
  ]
}

function ctxWithWeb(web) {
  const registrations = []
  const ctx = {
    on(event, listener) { registrations.push({ event, listener }); return () => {} },
    get(name) { return name === 'web' ? web : undefined },
  }
  return { ctx, registrations }
}

function searchResult(sources) {
  return { isError: false, value: { sources, truncated: false }, content: [{ type: 'text', text: original }] }
}

function callSearch(listener, sources, session = 'session-v') {
  return listener({ name: 'web_search', agent: { id: session } }, searchResult(sources), next)
}

// L1 finds a page that names an institution and a method -> grade floor C.
{
  const calls = []
  const anchoredPage = {
    statusCode: 200,
    truncated: false,
    body: {
      kind: 'html',
      content: '<html><body><p>国家统计局发布，本次调查样本为6万户，采用抽样方法。</p><p>该产业占全球73.6%。</p></body></html>',
    },
  }
  const web = { async fetch(request) { calls.push(request.url); return anchoredPage } }
  const { ctx, registrations } = ctxWithWeb(web)
  apply(ctx, { verify: true, minSources: 3 })
  const out = await callSearch(registrations[0].listener, poisonedSet(), 'session-p1')
  const text = out.content.length > 1 ? out.content[0].text : ''
  ok('L1 fetches the picked origin', calls.length === 1, calls)
  ok('L1 note appears', text.includes('补证'), text)
  ok('L1 upgrades D to C', text.includes('C 级'), text)
}

// L1 bland + L2 finds a primary page carrying the figure -> grade B.
{
  const calls = { fetch: [], search: [] }
  const blandPage = { statusCode: 200, truncated: false, body: { kind: 'text', content: '有数据显示，该产业占全球73.6%，业内看好。' } }
  const web = {
    async fetch(request) { calls.fetch.push(request.url); return blandPage },
    async search(request) {
      calls.search.push(request.query)
      return {
        content: '',
        truncated: false,
        sources: [
          { url: 'https://a-news.com/1', title: '同批站点', snippet: '73.6%' },
          { url: 'https://www.stats.gov.cn/sj/zxfb/2026.html', title: '统计公报', snippet: '该产业占比 73.6%' },
        ],
      }
    },
  }
  const { ctx, registrations } = ctxWithWeb(web)
  apply(ctx, { verify: true, minSources: 3 })
  const out = await callSearch(registrations[0].listener, poisonedSet(), 'session-p2')
  const text = out.content.length > 1 ? out.content[0].text : ''
  ok('L2 runs after a bland page', calls.search.length === 1, calls.search)
  ok('L2 query quotes the figure', calls.search[0].startsWith('"73.6%"'), calls.search[0])
  ok('L2 hit upgrades to B', text.includes('B 级'), text)
  ok('L2 note carries the url', text.includes('stats.gov.cn'), text)
}

// Probe budget is enforced per session.
{
  const calls = []
  const blandPage = { statusCode: 200, truncated: false, body: { kind: 'text', content: '该产业73.6%，市场看好。' } }
  const web = {
    async fetch(request) { calls.push(request.url); return blandPage },
    async search() { return { sources: [] } },
  }
  const { ctx, registrations } = ctxWithWeb(web)
  apply(ctx, { verify: true, minSources: 3, maxProbes: 1, minIntervalMs: 0 })
  await callSearch(registrations[0].listener, poisonedSet(), 'session-budget')
  const afterFirst = calls.length
  await callSearch(registrations[0].listener, poisonedSet(), 'session-budget')
  ok('budget stops the second probe', calls.length === afterFirst, { afterFirst, total: calls.length })
}

// The same claim family is never probed twice, even with budget left.
{
  const calls = []
  const blandPage = { statusCode: 200, truncated: false, body: { kind: 'text', content: '该产业73.6%，市场看好。' } }
  const web = {
    async fetch(request) { calls.push(request.url); return blandPage },
    async search() { return { sources: [] } },
  }
  const { ctx, registrations } = ctxWithWeb(web)
  apply(ctx, { verify: true, minSources: 3, maxProbes: 5, minIntervalMs: 0 })
  await callSearch(registrations[0].listener, poisonedSet(), 'session-family')
  const afterFirst = calls.length
  await callSearch(registrations[0].listener, poisonedSet(), 'session-family')
  ok('claim family cached', calls.length === afterFirst, { afterFirst, total: calls.length })
}

// A throwing provider must not break the tool result.
{
  const web = { async fetch() { throw new Error('network down') }, async search() { throw new Error('down') } }
  const { ctx, registrations } = ctxWithWeb(web)
  apply(ctx, { verify: true, minSources: 3 })
  const out = await callSearch(registrations[0].listener, poisonedSet(), 'session-err')
  const text = out.content.length > 1 ? out.content[0].text : ''
  ok('provider failure degrades to a plain banner', out.kind === 'accept' && text.includes('来源审计'), text)
  ok('no verification note on failure', !text.includes('补证'), text)
}

// No web service at all: annotation still works.
{
  const { ctx, registrations } = ctxWithWeb(undefined)
  apply(ctx, { verify: true, minSources: 3 })
  const out = await callSearch(registrations[0].listener, poisonedSet(), 'session-noweb')
  ok('works without ctx.web', out.content.length === 2)
}

// A provider that never settles must not hang the tool result.
{
  const web = {
    fetch() { return new Promise(() => {}) },
    search() { return new Promise(() => {}) },
  }
  const { ctx, registrations } = ctxWithWeb(web)
  apply(ctx, { verify: true, minSources: 3, verifyTimeoutMs: 150, maxProbes: 2 })
  const started = Date.now()
  const out = await Promise.race([
    callSearch(registrations[0].listener, poisonedSet(), 'session-hang'),
    new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 3000)),
  ])
  const elapsed = Date.now() - started
  ok('never-settling provider cannot hang the call', out !== 'TIMEOUT', { elapsed })
  ok('still returns the banner', typeof out === 'object' && out.kind === 'accept')
}

// Async mode: the banner returns immediately and the finding is injected later.
{
  const injected = []
  const anchoredPage = {
    statusCode: 200,
    truncated: false,
    body: { kind: 'text', content: '国家统计局发布，本次调查样本为6万户。该产业占全球73.6%。' },
  }
  const web = { async fetch() { return anchoredPage } }
  const agents = {
    get(id) { return { id, inject(message) { injected.push(message) } } },
  }
  const registrations = []
  const ctx = {
    on(event, listener) { registrations.push({ event, listener }); return () => {} },
    get(name) {
      if (name === 'web') return web
      if (name === 'agents') return agents
      return undefined
    },
  }
  apply(ctx, { verify: true, asyncVerify: true, minSources: 3 })

  const started = Date.now()
  const out = await callSearch(registrations[0].listener, poisonedSet(), 'session-async')
  const elapsed = Date.now() - started
  const text = out.content.length > 1 ? out.content[0].text : ''

  ok('async banner returns immediately', elapsed < 1000, elapsed)
  ok('async banner announces the pending probe', text.includes('补证已转入后台'), text)

  await settleProbes()
  ok('finding injected into the inbox', injected.length === 1, injected.length)
  const note = injected[0] || {}
  ok('injected note has a stable identity', typeof note.id === 'string' && note.id.length > 0, note.id)
  ok('injected note is a user message', note.role === 'user', note.role)
  ok(
    'injected note carries a producer-owned source kind',
    note.source !== null && typeof note.source === 'object' && note.source.kind === 'plugin:provenance-guard',
    note.source,
  )
  ok(
    'notice source carries a bounded summary',
    note.source !== null && note.source.form === 'notice'
      && typeof note.source.summary === 'string' && note.source.summary.length <= 120,
    note.source,
  )
  const body = note.content ? note.content[0].text : ''
  ok('injected note carries the result', body.includes('补证') && body.includes('上调'), body)
}

// Async mode must not inject anything when the provider returns nothing usable.
{
  const injected = []
  const web = { async fetch() { return { statusCode: 404, truncated: false, body: { kind: 'text', content: '' } } } }
  const agents = { get(id) { return { id, inject(message) { injected.push(message) } } } }
  const registrations = []
  const ctx = {
    on(event, listener) { registrations.push({ event, listener }); return () => {} },
    get(name) {
      if (name === 'web') return web
      if (name === 'agents') return agents
      return undefined
    },
  }
  apply(ctx, { verify: true, asyncVerify: true, searchProbe: false, minSources: 3 })
  await callSearch(registrations[0].listener, poisonedSet(), 'session-async2')
  await settleProbes()
  ok('empty page injects nothing', injected.length === 0, injected.length)
}

// ---------------------------------------------------------------------------
// v0.5: source_ledger tool (A) and live JSON config (C)
// ---------------------------------------------------------------------------
{
  const registrations = []
  const tools = []
  const ctx = {
    on(event, listener) {
      registrations.push({ event, listener })
      return () => {}
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    get() {
      return undefined
    },
  }
  apply(ctx, { minSources: 3, verify: false })

  const tool = tools.find(candidate => candidate.name === 'source_ledger')
  ok('ledger tool registered', tool !== undefined, tools.map(candidate => candidate.name))
  ok('claim tool registered', tools.some(candidate => candidate.name === 'audit_claim'), tools.map(candidate => candidate.name))

  const empty = tool.execute({}, { agent: { id: 'session-ledger' } })
  ok('empty ledger says so', typeof empty.text === 'string' && empty.text.includes('台账为空'), empty.text)

  await callSearch(registrations[0].listener, poisonedSet(), 'session-ledger')
  const ledger = tool.execute({ limit: 5, urls: true }, { agent: { id: 'session-ledger' } })
  ok('ledger counts the search', ledger.text.includes('1 次检索'), ledger.text)
  ok('ledger reports K and the grade', /K=\d+/.test(ledger.text) && /[ABCD] 级/.test(ledger.text), ledger.text)
  ok('ledger lists urls on request', ledger.text.includes('https://'), ledger.text)
  ok('ledger reports the effective config', ledger.text.includes('minSources=3'), ledger.text)
  ok('ledger output renders as one text block', tool.output.render({}, ledger)[0].type === 'text')
  const other = tool.execute({}, { agent: { id: 'session-other' } })
  ok('ledger is per session', other.text.includes('台账为空'), other.text)
}

{
  const file = join(tmpdir(), `provenance-guard-${randomUUID()}.json`)
  const previous = process.env.DSH_PROVENANCE_CONFIG
  process.env.DSH_PROVENANCE_CONFIG = file
  try {
    writeFileSync(file, JSON.stringify({ minSources: 99 }))
    const registrations = []
    const ctx = {
      on(event, listener) {
        registrations.push({ event, listener })
        return () => {}
      },
      get() {
        return undefined
      },
    }
    apply(ctx, { minSources: 3, verify: false })

    const quiet = await callSearch(registrations[0].listener, poisonedSet(), 'session-cfg')
    ok('config file overrides the patch (no banner)', quiet.content.length === 1, quiet.content.map(block => block.text))

    writeFileSync(file, JSON.stringify({ minSources: 2, debug: true }))
    const loud = await callSearch(registrations[0].listener, poisonedSet(), 'session-cfg')
    ok('an edited file applies to the next search', loud.content.length > 1, loud.content.map(block => block.text))
  } finally {
    if (previous === undefined) delete process.env.DSH_PROVENANCE_CONFIG
    else process.env.DSH_PROVENANCE_CONFIG = previous
    rmSync(file, { force: true })
  }
}

{
  const file = join(tmpdir(), `provenance-guard-ledger-${randomUUID()}.json`)
  const previous = process.env.DSH_PROVENANCE_LEDGER
  process.env.DSH_PROVENANCE_LEDGER = file
  try {
    const tools = []
    const ctx = {
      on() {
        return () => {}
      },
      tools: {
        register(definition) {
          tools.push(definition)
          return () => {}
        },
      },
      get() {
        return undefined
      },
    }
    const registrations = []
    const recording = {
      ...ctx,
      on(event, listener) {
        registrations.push({ event, listener })
        return () => {}
      },
    }
    apply(recording, { minSources: 3, verify: false })
    await callSearch(registrations[0].listener, poisonedSet(), 'session-persist')
    const before = tools.find(candidate => candidate.name === 'source_ledger')
      .execute({}, { agent: { id: 'session-persist' } })
    ok('ledger records the search', before.text.includes('1 次检索'), before.text)

    // A separately imported module instance is what a harness restart looks like.
    const restarted = await import(`../index.js?restart=${Date.now()}`)
    const after = []
    restarted.apply(
      {
        on() {
          return () => {}
        },
        tools: {
          register(definition) {
            after.push(definition)
            return () => {}
          },
        },
        get() {
          return undefined
        },
      },
      { minSources: 3, verify: false },
    )
    const hydrated = after.find(candidate => candidate.name === 'source_ledger')
      .execute({}, { agent: { id: 'session-persist' } })
    ok('ledger survives a restart', hydrated.text.includes('1 次检索'), hydrated.text)
  } finally {
    if (previous === undefined) delete process.env.DSH_PROVENANCE_LEDGER
    else process.env.DSH_PROVENANCE_LEDGER = previous
    rmSync(file, { force: true })
  }
}

// ---------------------------------------------------------------------------
// v0.7: audit_claim — one bounded search plus one bounded fetch
// ---------------------------------------------------------------------------
function claimContext({ search, fetch: fetchPage }) {
  const tools = []
  return {
    tools,
    ctx: {
      on() {
        return () => {}
      },
      tools: {
        register(definition) {
          tools.push(definition)
          return () => {}
        },
      },
      get(name) {
        if (name !== 'web') return undefined
        return { search, fetch: fetchPage }
      },
    },
  }
}

{
  const page = {
    statusCode: 200,
    truncated: false,
    body: { kind: 'html', content: '<p>乘联会发布：2025年新能源乘用车渗透率达到53.9%，统计口径为乘用车零售。</p>' },
  }
  const { tools, ctx } = claimContext({
    async search(request) {
      return {
        sources: [
          { url: 'https://www.cpcaauto.com/news/1', title: '2025年新能源乘用车渗透率53.9%', snippet: '乘联会发布月度分析。', publishedAt: '2026-01-26T02:00:00Z' },
          { url: 'https://a1-news.com/x', title: '新能源渗透率53.9%', snippet: '据乘联会数据，渗透率53.9%。', publishedAt: '2026-01-26T05:00:00Z' },
          { url: 'https://a2-news.com/y', title: '新能源渗透率53.9%', snippet: '据乘联会数据，渗透率53.9%。', publishedAt: '2026-01-26T06:00:00Z' },
          { url: 'https://a3-news.com/z', title: '新能源渗透率53.9%', snippet: '据乘联会数据，渗透率53.9%。', publishedAt: '2026-01-26T07:00:00Z' },
        ],
        truncated: false,
      }
    },
    async fetch() {
      return page
    },
  })
  apply(ctx, { minSources: 3, verify: false })
  const tool = tools.find(candidate => candidate.name === 'audit_claim')
  ok('claim tool has a schema', tool && tool.parameters.type === 'object' && tool.output.schema.required.includes('text'))

  const out = await tool.execute({ claim: '2025年新能源乘用车渗透率53.9%' }, { agent: { id: 'session-claim' } })
  ok('claim report names the claim', out.text.includes('2025年新能源乘用车渗透率53.9%'), out.text)
  ok('claim report gives a verdict', /结论：[ABCD] 级/.test(out.text), out.text)
  ok('claim report names the search it ran', out.text.includes('「"53.9%"'), out.text)
  ok('claim report names the earliest source', out.text.includes('最早见于 cpcaauto.com'), out.text)
  ok('claim report says what the page contained', /· 页面：/.test(out.text), out.text)
  ok('claim report ends with advice', /· 建议：/.test(out.text), out.text)
  ok('claim report stays bounded', out.text.length <= 1200, out.text.length)
  ok('claim report is renderable', tool.output.render({}, out)[0].type === 'text')
}

{
  // No web service: a tool result, never a throw.
  const { tools, ctx } = claimContext({ search: undefined, fetch: undefined })
  apply(ctx, { minSources: 3, verify: false })
  const tool = tools.find(candidate => candidate.name === 'audit_claim')
  const out = await tool.execute({ claim: '某数字 73.6%' }, { agent: { id: 'session-claim2' } })
  ok('missing web degrades to a sentence', out.text.includes('无法核查'), out.text)

  const empty = await tool.execute({ claim: '   ' }, { agent: { id: 'session-claim2' } })
  ok('empty claim is rejected', empty.text.includes('没有给出'), empty.text)
}

{
  // A generator page that does NOT carry the figure must not justify A/B: the
  // set is "authoritative" only in composition, not about this number.
  const { tools, ctx } = claimContext({
    async search() {
      return {
        sources: [
          { url: 'https://www.yangzhou.gov.cn/a', title: '全市新能源产业发展情况', snippet: '全市新能源产业发展迅速。', publishedAt: '2026-01-01T00:00:00Z' },
          { url: 'https://a1-news.com/x', title: '渗透率53.9%', snippet: '有数据显示53.9%。', publishedAt: '2026-01-02T00:00:00Z' },
          { url: 'https://a2-news.com/y', title: '渗透率53.9%', snippet: '有数据显示53.9%。', publishedAt: '2026-01-03T00:00:00Z' },
        ],
        truncated: false,
      }
    },
    async fetch() {
      return { statusCode: 200, truncated: false, body: { kind: 'text', content: '全市新能源产业发展迅速，未提及渗透率。' } }
    },
  })
  apply(ctx, { minSources: 3, verify: false })
  const tool = tools.find(candidate => candidate.name === 'audit_claim')
  const out = await tool.execute({ claim: '新能源乘用车渗透率53.9%' }, {})
  ok('a generator page without the figure cannot justify A/B', /结论：D 级/.test(out.text), out.text)
  ok('the report says why', out.text.includes('里没有这个数字'), out.text)
  ok('the report still carries the set grade', /结果集 [ABCD] 级/.test(out.text), out.text)
}

{
  // No page reachable: the ceiling is C, never the set's grade.
  const { tools, ctx } = claimContext({
    async search() {
      return {
        sources: [
          { url: 'https://b1-news.com/1', title: '渗透率53.9%', snippet: '有数据显示53.9%。', publishedAt: '2026-02-01T00:00:00Z' },
          { url: 'https://b2-news.com/2', title: '渗透率53.9%', snippet: '有数据显示53.9%。', publishedAt: '2026-02-02T00:00:00Z' },
          { url: 'https://b3-news.com/3', title: '渗透率53.9%', snippet: '有数据显示53.9%。', publishedAt: '2026-02-03T00:00:00Z' },
        ],
        truncated: false,
      }
    },
    async fetch() {
      throw new Error('timeout')
    },
  })
  apply(ctx, { minSources: 3, verify: false })
  const tool = tools.find(candidate => candidate.name === 'audit_claim')
  const out = await tool.execute({ claim: '渗透率53.9%' }, {})
  ok('an unfetched page caps the claim at C', /结论：C 级/.test(out.text), out.text)
  ok('the report admits it could not verify', out.text.includes('没有取到原文'), out.text)
}

console.log(`\n${passed} checks passed\n`)