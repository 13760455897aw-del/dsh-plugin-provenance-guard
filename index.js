/**
 * 来源审计 / Provenance Guard — a Host-only DSH plugin.
 *
 * It wraps `web_search` results at the moment they enter the model's context
 * and prepends a compact provenance block: how many independent source lineages
 * the N results really collapse into, whether any generative (primary) source is
 * present, and whether attribution breaks.
 *
 * It never deletes sources and never calls a verdict of "false". It only bounds
 * how strongly a claim may be asserted, and — when a set is bad enough to warn
 * about — spends at most one or two bounded network calls trying to find the
 * generating source.
 */

import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ACTION, DEFAULTS, analyze, firstPreciseNumber, isPrimarySite, render, siteOf, titleKey } from './lib/audit.js'
import {
  describeVerification,
  fingerprintQuery,
  inspectPage,
  inspectSearchResults,
  pickOrigin,
} from './lib/verify.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'provenance-guard'

/** The tool registry must be up before we can listen to its dispatch pipeline. */
export const inject = ['tools']

const MAX_SESSIONS = 32
const MAX_URLS_PER_SESSION = 400
const MAX_TITLES_PER_SESSION = 400
const MAX_LEDGER_ENTRIES = 20
const MAX_LEDGER_FILE_BYTES = 256 * 1024
const MAX_LEDGER_FILE_SESSIONS = 8
const LEDGER_MAX_CHARS = 2400

/** Same-origin route the header chip fetches; must match `lib/client.js`. */
const LEDGER_ROUTE = '/provenance-guard/ledger'
/** Upper bound for one audit_claim answer; it is a tool result, not a report. */
const CLAIM_MAX_CHARS = 1200

/**
 * Durable attribution for the notes this plugin injects.
 *
 * A third-party plugin's producer kind is `plugin:<plugin name>`; `plugin` by
 * itself is retired and refused by the v4 reader. The bound matches
 * `CONTEXT_SUMMARY_MAX_CHARS` in `@deepseek-ai/dsh-llm`.
 */
const NOTICE_SOURCE_KIND = 'plugin:provenance-guard'
const NOTICE_SUMMARY_MAX_CHARS = 120

/** Verification budget defaults — deliberately conservative. */
const VERIFY_DEFAULTS = {
  // Off by default: every probe in measurement exceeded 5 s, and a synchronous
  // probe adds that latency to the tool result. `asyncVerify` is the fix —
  // run it in the background and inject the finding into the next step.
  verify: false,
  asyncVerify: false,
  verifyAll: false,
  searchProbe: true,
  maxProbes: 2,
  minIntervalMs: 45000,
  verifyTimeoutMs: 12000,
  debug: false,
}

const GRADE_RANK = { D: 0, C: 1, B: 2, A: 3 }

function raiseGrade(grade, floor) {
  const current = GRADE_RANK[grade]
  const target = GRADE_RANK[floor]
  if (current === undefined || target === undefined) return grade
  return current >= target ? grade : floor
}

function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const number = (value, fallback) => (
    typeof value === 'number' && Number.isFinite(value) ? value : fallback
  )
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback)
  return {
    ...DEFAULTS,
    ...raw,
    minSources: Math.max(2, Math.round(number(raw.minSources, DEFAULTS.minSources))),
    maxBlockChars: Math.max(200, Math.round(number(raw.maxBlockChars, DEFAULTS.maxBlockChars))),
    extraPrimaryHosts: Array.isArray(raw.extraPrimaryHosts)
      ? raw.extraPrimaryHosts.filter(host => typeof host === 'string')
      : [],
    verify: bool(raw.verify, VERIFY_DEFAULTS.verify),
    asyncVerify: bool(raw.asyncVerify, VERIFY_DEFAULTS.asyncVerify),
    verifyAll: bool(raw.verifyAll, VERIFY_DEFAULTS.verifyAll),
    searchProbe: bool(raw.searchProbe, VERIFY_DEFAULTS.searchProbe),
    maxProbes: Math.max(0, Math.round(number(raw.maxProbes, VERIFY_DEFAULTS.maxProbes))),
    minIntervalMs: Math.max(0, number(raw.minIntervalMs, VERIFY_DEFAULTS.minIntervalMs)),
    verifyTimeoutMs: Math.max(500, number(raw.verifyTimeoutMs, VERIFY_DEFAULTS.verifyTimeoutMs)),
    debug: bool(raw.debug, VERIFY_DEFAULTS.debug),
  }
}

/** Harness state root, honoring `DSH_HOME`. */
function dshHome() {
  const home = process.env.DSH_HOME
  return typeof home === 'string' && home.length > 0 ? home : join(homedir(), '.dsh')
}

/**
 * Where the live config lives.
 *
 * `DSH_PROVENANCE_CONFIG` wins so one workspace can point at its own file; the
 * default sits beside the harness state (`$DSH_HOME/provenance-guard.json`).
 */
function configFilePath() {
  const override = process.env.DSH_PROVENANCE_CONFIG
  if (typeof override === 'string' && override.length > 0) return override
  return join(dshHome(), 'provenance-guard.json')
}

/** Last successfully parsed file, keyed by its stat revision. */
let fileCache = { revision: '', value: {}, warned: '' }

/**
 * Read the optional JSON config, re-parsing only when the file changes.
 *
 * The file is the tuning surface: edit it and the next tool call uses the new
 * values, with no reinstall and no restart. A half-saved or malformed file is
 * reported once and ignored — it must never reset the plugin to defaults.
 */
function readConfigFile() {
  const file = configFilePath()
  let revision = ''
  try {
    const stat = statSync(file)
    revision = `${file}:${stat.mtimeMs}:${stat.size}`
  } catch {
    fileCache = { revision: '', value: {}, warned: '' }
    return { file, value: {}, present: false }
  }
  if (revision === fileCache.revision) return { file, value: fileCache.value, present: true }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must hold one JSON object')
    }
    fileCache = { revision, value: parsed, warned: '' }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    if (fileCache.warned !== revision) {
      fileCache.warned = revision
      console.warn(`[provenance-guard] ignoring ${file}: ${message}`)
    }
    fileCache.revision = revision
  }
  return { file, value: fileCache.value, present: true }
}

/** Patch config, overridden by the live file, normalized once. */
function resolveOptions(base) {
  const { file, value, present } = readConfigFile()
  const options = normalizeConfig({
    ...(base && typeof base === 'object' ? base : {}),
    ...value,
  })
  options.configFile = present ? file : ''
  return options
}

/**
 * Where the ledger lives.
 *
 * The memory map alone dies with the process, and a ledger that forgets every
 * restart is useless right after one. One small JSON file keeps it across
 * restarts; `DSH_PROVENANCE_LEDGER` overrides the location.
 */
function ledgerFilePath() {
  const override = process.env.DSH_PROVENANCE_LEDGER
  if (typeof override === 'string' && override.length > 0) return override
  return join(dshHome(), 'provenance-guard-ledger.json')
}

/** Last successfully parsed ledger, keyed by its stat revision. */
let ledgerCache = { revision: '', sessions: {} }

/**
 * Read the persisted ledger, re-parsing only when the file changes.
 *
 * A missing file is normal (first run); a damaged one keeps the last good
 * view — the ledger is a convenience and must never block a search.
 */
function readLedgerFile() {
  const file = ledgerFilePath()
  let revision = ''
  try {
    const stat = statSync(file)
    revision = `${file}:${stat.mtimeMs}:${stat.size}`
  } catch {
    return ledgerCache
  }
  if (revision === ledgerCache.revision) return ledgerCache
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const sessions = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    ledgerCache = { revision, sessions }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    console.warn(`[provenance-guard] ignoring ledger ${file}: ${message}`)
    ledgerCache.revision = revision
  }
  return ledgerCache
}

/** Persist one session's rows through a temp file and a rename. */
function saveSessionLedger(sessionId, queries) {
  const file = ledgerFilePath()
  const sessions = { ...readLedgerFile().sessions, [sessionId]: queries }
  let ids = Object.keys(sessions)
  if (ids.length > MAX_SESSIONS) {
    const lastAt = id => {
      const rows = Array.isArray(sessions[id]) ? sessions[id] : []
      return rows.length === 0 ? 0 : Number(rows[rows.length - 1]?.at) || 0
    }
    ids = ids.sort((a, b) => lastAt(b) - lastAt(a))
    for (const stale of ids.slice(MAX_SESSIONS)) delete sessions[stale]
  }
  // One write per search; keep the file small enough that this stays cheap.
  let payload = JSON.stringify(sessions)
  if (payload.length > MAX_LEDGER_FILE_BYTES) {
    const trimmed = {}
    for (const id of ids.slice(0, MAX_LEDGER_FILE_SESSIONS)) trimmed[id] = sessions[id]
    payload = JSON.stringify(trimmed)
  }
  try {
    const temp = `${file}.tmp`
    writeFileSync(temp, payload)
    renameSync(temp, file)
    const stat = statSync(file)
    ledgerCache = { revision: `${file}:${stat.mtimeMs}:${stat.size}`, sessions }
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    console.warn(`[provenance-guard] ledger write failed: ${message}`)
  }
}

/** Per-session corpus and probe budget. */
function createMemory() {
  return {
    sessions: new Map(),
    session(id) {
      let entry = this.sessions.get(id)
      if (entry === undefined) {
        if (this.sessions.size >= MAX_SESSIONS) {
          const oldest = this.sessions.keys().next().value
          this.sessions.delete(oldest)
        }
        const persisted = readLedgerFile().sessions[id]
        entry = {
          urls: new Set(),
          titles: new Map(),
          probes: 0,
          lastProbeAt: 0,
          families: new Set(),
          queries: Array.isArray(persisted) ? persisted.slice(-MAX_LEDGER_ENTRIES) : [],
        }
        this.sessions.set(id, entry)
      }
      return entry
    },
  }
}

function remember(entry, sources) {
  for (const source of sources) {
    if (!source || typeof source.url !== 'string') continue
    if (entry.urls.size < MAX_URLS_PER_SESSION) entry.urls.add(source.url)
    if (typeof source.title !== 'string' || entry.titles.size >= MAX_TITLES_PER_SESSION) continue
    const key = titleKey(source.title)
    if (key.length < 6 || entry.titles.has(key)) continue
    let site = ''
    try {
      site = new URL(source.url).hostname
    } catch {
      site = ''
    }
    entry.titles.set(key, site)
  }
}

/**
 * Keep the audited shape of one search, so the model can ask what it already
 * saw instead of re-running the same query. URLs are capped; the ledger is a
 * map of sites and grades, not a copy of the search results.
 */
function recordQuery(sessionId, entry, report, sources) {
  const urls = []
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || typeof source.url !== 'string') continue
    urls.push(source.url)
    if (urls.length >= 12) break
  }
  entry.queries.push({
    at: Date.now(),
    n: typeof report.n === 'number' ? report.n : 0,
    k: typeof report.k === 'number' ? report.k : 0,
    siteCount: typeof report.siteCount === 'number' ? report.siteCount : 0,
    platformCount: typeof report.platformCount === 'number' ? report.platformCount : 0,
    primarySites: Array.isArray(report.primarySites) ? report.primarySites.slice(0, 3) : [],
    grade: typeof report.grade === 'string' ? report.grade : '-',
    level: typeof report.level === 'string' ? report.level : 'silent',
    // The substance: what was asserted, where it first appeared, and whether a
    // generator carried it. A ledger of counts alone cannot be acted on.
    claim: typeof report.claim === 'string' ? report.claim : '',
    originSite: report.origin && typeof report.origin.site === 'string' ? report.origin.site : '',
    originUrl: report.origin && typeof report.origin.url === 'string' ? report.origin.url : '',
    originAt: report.origin && typeof report.origin.at === 'number' ? report.origin.at : 0,
    echoes: typeof report.echoes === 'number' ? report.echoes : 0,
    anchored: report.anchored === true,
    mismatched: report.mismatchedPrimary === true,
    majorMedia: Array.isArray(report.majorMedia) ? report.majorMedia.slice(0, 3) : [],
    urls,
  })
  if (entry.queries.length > MAX_LEDGER_ENTRIES) {
    entry.queries.splice(0, entry.queries.length - MAX_LEDGER_ENTRIES)
  }
  saveSessionLedger(sessionId, entry.queries)
}

/** Local `MM-DD HH:MM` stamp; a persisted ledger spans restarts and days. */
function formatStamp(at) {
  const date = new Date(Number(at) || 0)
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) return ''
  const pad = value => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Distinct sites ever seen in one session's ledger. */
function sitesOfLedger(entry) {
  const sites = new Set()
  for (const url of entry.urls) {
    const site = siteOf(url)
    if (site) sites.add(site)
  }
  return [...sites]
}

/**
 * JSON view of one session's ledger, shared by the HTTP route the chip reads
 * and by any other consumer. Pure data: no URLs beyond the recorded rows.
 */
export function ledgerView(entry, options, sessionId) {
  const queries = Array.isArray(entry.queries) ? entry.queries : []
  const sites = sitesOfLedger(entry)
  return {
    sessionId,
    generatedAt: Date.now(),
    totals: {
      searches: queries.length,
      sources: queries.reduce((sum, query) => sum + (Number(query.n) || 0), 0),
      sites: sites.length,
    },
    queries: queries.map(query => ({
      at: query.at,
      n: query.n,
      k: query.k,
      grade: query.grade,
      level: query.level,
      siteCount: query.siteCount,
      platformCount: query.platformCount,
      primarySites: Array.isArray(query.primarySites) ? query.primarySites : [],
      claim: typeof query.claim === 'string' ? query.claim : '',
      originSite: typeof query.originSite === 'string' ? query.originSite : '',
      originAt: typeof query.originAt === 'number' ? query.originAt : 0,
      echoes: typeof query.echoes === 'number' ? query.echoes : 0,
      anchored: query.anchored === true,
      mismatched: query.mismatched === true,
      majorMedia: Array.isArray(query.majorMedia) ? query.majorMedia : [],
    })),
    options: {
      minSources: options.minSources,
      maxBlockChars: options.maxBlockChars,
      verify: options.verify,
      asyncVerify: options.asyncVerify,
      maxProbes: options.maxProbes,
      enabled: options.enabled !== false,
      configFile: typeof options.configFile === 'string' ? options.configFile : '',
    },
  }
}

/** Render one session's ledger for the model. */
function ledgerText(entry, options, sessionId, limit, withUrls) {
  const queries = entry.queries
  if (queries.length === 0) return '来源台账为空：本会话还没有经过审计的 web_search 结果。'

  const total = queries.reduce((sum, query) => sum + query.n, 0)
  const sites = sitesOfLedger(entry)
  const lines = [
    `来源台账 · ${sessionId}`,
    `${queries.length} 次检索 / ${total} 条结果 / ${sites.length} 个站点`,
  ]
  const recent = queries.slice(-limit)
  const first = queries.length - recent.length + 1
  recent.forEach((query, index) => {
    const stamp = formatStamp(query.at)
    const bits = [
      `${first + index}.${stamp.length > 0 ? ` ${stamp}` : ''} n=${query.n} K=${query.k}`,
      `${query.grade} 级`,
      query.level,
      `${query.siteCount} 站点`,
    ]
    if (query.platformCount > 0) bits.push(`${query.platformCount} 自媒体`)
    lines.push(bits.join(' · '))
    if (query.claim || query.originSite) {
      const claim = query.claim ? `主张 ${query.claim}` : ''
      const origin = query.originSite ? `最早 ${query.originSite}` : ''
      lines.push(`   ${[claim, origin].filter(part => part.length > 0).join(' · ')}`)
    }
    if (query.mismatched) lines.push('   注意：权威页未及该数字，引用前需核对')
    if (Array.isArray(query.majorMedia) && query.majorMedia.length > 0) {
      lines.push(`   大媒体：${query.majorMedia.join('、')}`)
    }
    if (query.primarySites.length > 0) lines.push(`   一手源：${query.primarySites.join('、')}`)
    if (withUrls && query.urls.length > 0) lines.push(`   来源：${query.urls.join(' ')}`)
  })

  const flags = [
    `minSources=${options.minSources}`,
    `verify=${options.verify}`,
    `async=${options.asyncVerify}`,
    `maxProbes=${options.maxProbes}`,
  ]
  lines.push(`配置：${flags.join(' ')}${options.configFile ? ` · 文件 ${options.configFile}` : ''}`)
  // The tool result is model context: bound it even when every URL is asked for.
  const text = lines.join('\n')
  return text.length <= LEDGER_MAX_CHARS ? text : text.slice(0, LEDGER_MAX_CHARS - 1) + '…'
}

/**
 * Register the model-facing ledger tool.
 *
 * Tool definitions are built here instead of importing `defineTool`: the
 * shipped `@deepseek-ai/*` packages live in the app archive and are not
 * resolvable from a workspace plugin, while `ctx.tools.register` accepts the
 * compiled shape directly (name/description/parameters/output/execute).
 */
function registerLedgerTool(ctx, memory, currentOptions) {
  ctx.tools.register({
    name: 'source_ledger',
    description: 'Read this session\'s provenance ledger: every web_search result set already audited, with its source count N, folded lineage count K, warrant grade, and the sites it collapses to. Call it before repeating a search, or when you must say which sites a claim actually traces to.',
    parameters: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: 'How many recent searches to list. Default 5, max 20.',
        },
        urls: {
          type: 'boolean',
          description: 'Also list the source URLs of each search. Default false.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    execute(args, exec) {
      const requested = Math.round(Number(args && args.limit))
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(20, requested)) : 5
      const sessionId = exec && exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : 'default'
      const options = currentOptions()
      return {
        text: ledgerText(memory.session(sessionId), options, sessionId, limit, Boolean(args && args.urls === true)),
      }
    },
  })
}

/** What to do with a grade, as one actionable sentence. */
function adviceFor(grade) {
  if (grade === 'A' || grade === 'B') return '可以引用，但必须同时给出一手源链接；不要只写结论。'
  if (grade === 'C') return '只能写成「据 X 报道」并附链接；不要写成「数据显示」。'
  return '不要给出具体数值；若必须提及，写成「有说法称…（未获独立证实）」。'
}

/**
 * Decide the claim's grade from what was actually verified.
 *
 * A result set can look authoritative and still not contain the figure: one
 * government page in a mixed set would hand out "A 级 — 可断言" for a number
 * that page never mentions. For a single claim the fetched page decides, and
 * the set composition is only context.
 *
 * @returns {{ grade: string, basis: string, setGrade: string }}
 */
function claimVerdict({ number, pageTarget, pageInfo, report }) {
  const setGrade = typeof report.grade === 'string' ? report.grade : 'C'

  if (number.length === 0) {
    return {
      grade: setGrade,
      basis: '这句话没有可锚定的精确数字，结论只能按结果集的谱系给出',
      setGrade,
    }
  }
  if (!pageInfo) {
    return {
      grade: 'C',
      basis: '没有取到原文，就无法确认这个数字，最多只能写成「据 X 报道」',
      setGrade,
    }
  }
  const site = siteOf(pageTarget) || pageTarget
  if (pageInfo.hasNumber === true) {
    const generator = isPrimarySite(site, [])
    if (pageInfo.hasInstitution || pageInfo.hasMethod) {
      return {
        grade: generator ? 'B' : 'C',
        basis: `原文（${site}）${pageInfo.hasNumber ? '确实' : ''}有这个数字${pageInfo.hasMethod ? '，并给出了口径/方法' : ''}`,
        setGrade,
      }
    }
    return {
      grade: 'C',
      basis: `原文（${site}）有这个数字，但没给机构与口径`,
      setGrade,
    }
  }
  return {
    grade: 'D',
    basis: `原文（${site}）里没有这个数字——可能是转述时加上去的`,
    setGrade,
  }
}

/**
 * Compose the single-claim report.
 *
 * Everything here is observed, not inferred: the search that was run, the
 * earliest copy found, the generator that exists (or does not), what the
 * fetched page actually said, and one actionable sentence.
 */
function claimReportText({ claim, number, query, report, pageTarget, pageInfo }) {
  const lines = [`【单点核查】${claim}`]

  // Too few results is not a low grade — it is no evidence at all, and saying
  // "D 级" there would be a different (false) statement.
  if (report.reason === 'too-few-sources') {
    lines.push(`结论：证据不足 —— 检索只返回 ${report.n} 条结果（少于 3 条），无法判断谱系`)
    lines.push(`· 检索：「${query}」`)
    lines.push('· 建议：换一个更具体的说法再查，或人工核对原始页面。')
    return lines.join('\n')
  }

  const verdict = claimVerdict({ number, pageTarget, pageInfo, report })
  lines.push(`结论：${verdict.grade} 级 —— ${ACTION[verdict.grade] || ACTION.D}`)
  lines.push(`· 依据：${verdict.basis}`)
  lines.push(`· 检索：「${query}」→ ${report.n} 条 / ${report.siteCount} 站点 / ${report.k} 条谱系（结果集 ${verdict.setGrade} 级）`)

  const origin = report.origin
  if (origin && typeof origin.site === 'string') {
    const when = formatStamp(origin.at)
    const echoes = Number(report.echoes) || 0
    lines.push(`· 出处：最早见于 ${origin.site}${when.length > 0 ? `（${when}）` : ''}${echoes > 0 ? `，其后 ${echoes} 条同源转述` : ''}`)
  } else {
    lines.push('· 出处：结果集里没有可定位的最早来源')
  }

  if (number.length > 0 && pageTarget) {
    const where = siteOf(pageTarget) || pageTarget
    const what = pageInfo
      ? (pageInfo.outcome === 'anchored'
        ? `出现该数字${pageInfo.hasMethod ? '，含口径/方法说明' : ''}`
        : pageInfo.outcome === 'mismatch'
          ? '未出现该数字'
          : pageInfo.outcome === 'bland'
            ? '既无该数字也无机构说明'
            : '没有可用正文')
      : '抓取失败或超时，未核'
    lines.push(`· 页面：${where} → ${what}`)
  }

  if (report.hasPrimary) {
    lines.push(`· 一手源：结果集内出现生成方（${report.primarySites.slice(0, 2).join('、')}）`)
  } else if (number.length > 0) {
    lines.push('· 一手源：结果集内没有任何机构/论文/公报页面')
  }

  const pointer = pageTarget || (origin && origin.url) || ''
  if (pointer.length > 0) lines.push(`· 可核查：${pointer}`)
  lines.push(`· 建议：${adviceFor(verdict.grade)}`)

  const text = lines.join('\n')
  return text.length <= CLAIM_MAX_CHARS ? text : text.slice(0, CLAIM_MAX_CHARS - 1) + '…'
}

/**
 * Register the single-claim audit tool.
 *
 * The ledger answers "what did I already see"; this answers "is this one
 * number real". It spends at most one search and one page fetch, both bounded,
 * and reports what it observed rather than a score alone.
 */
function registerClaimTool(ctx, currentOptions) {
  ctx.tools.register({
    name: 'audit_claim',
    description: 'Audit one concrete claim before repeating it: runs a fingerprint search on its figure, folds the results into source lineages, fetches the likeliest origin page, and reports whether a generating source (institution, paper, filing) actually carries that figure. Use it when the user asks whether a number is real or where it came from, or before writing a precise statistic into a deliverable.',
    parameters: {
      type: 'object',
      properties: {
        claim: {
          type: 'string',
          description: 'The claim or figure to audit, ideally quoted from the draft, e.g. "2025年新能源乘用车渗透率53.9%".',
        },
      },
      required: ['claim'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const claim = String((args && args.claim) || '').trim()
      if (claim.length === 0) return { text: '没有给出要核查的主张。' }

      const options = currentOptions()
      const web = resolveWeb(ctx)
      if (!web || typeof web.search !== 'function') {
        return { text: '当前 profile 没有 web 服务，无法核查。' }
      }

      const number = firstPreciseNumber(claim)
      const query = number.length > 0 ? fingerprintQuery(number, claim) : claim.slice(0, 40)
      const signal = exec && exec.signal

      let found = null
      try {
        found = await bounded(
          requestSignal => web.search({ query, maxResults: 8 }, requestSignal),
          options.verifyTimeoutMs,
          signal,
          () => {},
        )
      } catch {
        found = null
      }
      if (!found) return { text: `核查失败：检索「${query}」没有返回结果或超时。` }

      const sources = Array.isArray(found.sources) ? found.sources : []
      if (sources.length === 0) return { text: `核查：检索「${query}」没有返回任何来源。` }

      const report = analyze(sources, options)
      // Fetch the generator when the result set has one: that is the page worth
      // checking, and the one a reader would cite. Otherwise fetch the earliest
      // editorially responsible copy, which is as close to an origin as exists.
      const primaryUrl = typeof report.primaryUrl === 'string' ? report.primaryUrl : ''
      const pageTarget = primaryUrl.length > 0
        ? primaryUrl
        : pickOrigin(report, sources, options.extraPrimaryHosts)

      let pageInfo = null
      if (pageTarget && typeof web.fetch === 'function') {
        const page = await bounded(
          requestSignal => web.fetch({ url: pageTarget }, requestSignal),
          options.verifyTimeoutMs,
          signal,
          () => {},
        )
        if (page) pageInfo = inspectPage(page, number, options.extraPrimaryHosts)
      }

      return { text: claimReportText({ claim, number, query, report, pageTarget, pageInfo }) }
    },
  })
}

/** Sessions whose ledger the browser half read in this process. */
const uiReadSessions = new Set()

/**
 * Record that the chip actually mounted and fetched, once per session.
 *
 * The chip lives in the renderer, where a failure is invisible from the host;
 * one line per session is how "the chip is missing" is told apart from "the
 * ledger is empty". Bounded and best-effort — diagnostics never break the route.
 */
function noteUiRead(sessionId) {
  if (uiReadSessions.size >= 8 || uiReadSessions.has(sessionId)) return
  uiReadSessions.add(sessionId)
  try {
    const dir = join(dshHome(), 'state', 'provenance-guard')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'ui.log'), `${new Date().toISOString()} chip read ledger for ${sessionId || '<none>'}\n`, 'utf8')
  } catch {
    /* never let a diagnostic write fail the request */
  }
}

/**
 * Serve the ledger JSON that the header chip reads. *
 * The chip renders in the browser and cannot reach plugin memory, so the host
 * exposes one read-only, same-origin route. `webServer` is optional: a profile
 * without it simply has no chip.
 */
function registerLedgerRoute(ctx, memory, currentOptions) {
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['webServer'], (inner) => {
      const server = inner && inner.webServer
      if (!server || typeof server.register !== 'function') return
      try {
        const dispose = server.register({
          kind: 'exact',
          path: LEDGER_ROUTE,
          handler(req, res) {
            try {
              const url = new URL(req.url ?? '/', 'http://localhost')
              const sessionId = url.searchParams.get('session') ?? ''
              noteUiRead(sessionId)
              const options = currentOptions()
              const view = ledgerView(memory.session(sessionId), options, sessionId)
              res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              })
              res.end(JSON.stringify(view))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: error && error.message ? error.message : String(error) }))
            }
          },
        })
        if (typeof inner.effect === 'function') inner.effect(() => dispose)
      } catch (error) {
        // A live instance already owns the path after an HMR re-apply.
        console.warn('[provenance-guard] ledger route unavailable:', error && error.message ? error.message : error)
      }
    })
  } catch (error) {
    console.warn('[provenance-guard] ledger route skipped:', error && error.message ? error.message : error)
  }
}

/**
 * One bounded call. Always settles: the abort signal asks the provider to stop,
 * and the race guarantees we stop waiting even if the provider ignores it.
 * Resolves null on error, timeout, or cancellation.
 */
async function bounded(call, timeoutMs, outerSignal, onError) {
  const controller = new AbortController()
  let signal = controller.signal
  try {
    if (outerSignal && typeof AbortSignal.any === 'function') {
      signal = AbortSignal.any([outerSignal, controller.signal])
    }
  } catch {
    signal = controller.signal
  }

  let timer
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      if (typeof onError === 'function') onError(new Error('timeout after ' + timeoutMs + 'ms'))
      resolve(null)
    }, timeoutMs)
  })

  try {
    const pending = Promise.resolve()
      .then(() => call(signal))
      .catch(error => {
        if (typeof onError === 'function') onError(error)
        return null
      })
    return await Promise.race([pending, deadline])
  } catch (error) {
    if (typeof onError === 'function') onError(error)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Try to find what actually produced an unanchored figure.
 *
 * L1 fetches the page most likely to be the origin. L2, only when L1 is
 * inconclusive, runs one quoted-fingerprint search. Both are budgeted.
 *
 * @returns a verification result, or null when nothing was attempted.
 */
async function runVerification(ctx, options, report, sources, session, signal) {
  const startedAt = Date.now()
  const result = await probeForOrigin(ctx, options, report, sources, session, signal)
  if (result) result.elapsedMs = Date.now() - startedAt
  return result
}

/** The web service, whether reached through the registry or the context. */
function resolveWeb(ctx) {
  let web = null
  try {
    if (typeof ctx.get === 'function') web = ctx.get('web') || null
  } catch {
    web = null
  }
  if (!web && ctx.web) web = ctx.web
  return web
}

async function probeForOrigin(ctx, options, report, sources, session, signal) {
  if (session.probes >= options.maxProbes) return null
  if (Date.now() - session.lastProbeAt < options.minIntervalMs) return null

  const web = resolveWeb(ctx)
  if (!web || typeof web.fetch !== 'function') return { kind: 'unavailable' }

  const number = report.preciseNumbers.length > 0 ? report.preciseNumbers[0].token : ''
  const firstTitle = sources.find(source => typeof source.title === 'string' && source.title.length > 0)
  const title = firstTitle ? firstTitle.title : ''
  const familyKey = number || 'x:' + report.k + ':' + report.siteCount + ':' + titleKey(title)
  if (session.families.has(familyKey)) return null

  session.families.add(familyKey)
  session.probes += 1
  session.lastProbeAt = Date.now()

  const origin = pickOrigin(report, sources, options.extraPrimaryHosts)
  let pageResult = null
  let lastError = ''

  const capture = (error) => {
    lastError = error && error.message ? String(error.message) : String(error)
  }
  if (origin) {
    const page = await bounded(
      requestSignal => web.fetch({ url: origin }, requestSignal),
      options.verifyTimeoutMs,
      signal,
      capture,
    )
    if (page) {
      const info = inspectPage(page, number, options.extraPrimaryHosts)
      const site = siteOf(origin)
      if (info.outcome === 'anchored') {
        return {
          kind: 'page',
          outcome: 'anchored',
          site,
          hasMethod: info.hasMethod,
          hasInstitution: info.hasInstitution,
          primaryLinks: info.primaryLinks,
        }
      }
      if (info.outcome === 'mismatch') {
        return { kind: 'page', outcome: 'mismatch', site }
      }
      pageResult = { kind: 'page', outcome: info.outcome, site }
    } else {
      pageResult = { kind: 'fetch-failed', site: siteOf(origin), error: lastError }
    }
  }

  if (!options.searchProbe) return pageResult || { kind: 'no-origin' }
  if (number.length === 0) return pageResult || { kind: 'no-number' }
  const query = fingerprintQuery(number, title)
  if (query.length === 0) return pageResult || { kind: 'no-number' }

  if (session.probes >= options.maxProbes) return pageResult
  session.probes += 1
  session.lastProbeAt = Date.now()

  const found = await bounded(
    requestSignal => web.search({ query, maxResults: 6 }, requestSignal),
    options.verifyTimeoutMs,
    signal,
    capture,
  )
  if (!found) return pageResult || { kind: 'search-failed', error: lastError }
  const hit = inspectSearchResults(found, number, options.extraPrimaryHosts)
  return { kind: 'search', ...hit }
}

/**
 * Build the message the inbox stores verbatim.
 *
 * `agent.inject()` seals nothing: the message reaches the durable session log
 * exactly as given, and a v4 session refuses to load when any message lacks a
 * producer-owned `source.kind` — one empty source once made a whole session
 * unreadable. A third-party plugin's kind is `plugin:<plugin name>`, and
 * `notice` sources carry a one-line `summary`.
 *
 * @param text - the finding to hand to the next admitted step.
 * @returns a complete, identified, attributed user-role message.
 */
function noticeMessage(text) {
  const summary = text.length <= NOTICE_SUMMARY_MAX_CHARS
    ? text
    : `${text.slice(0, NOTICE_SUMMARY_MAX_CHARS - 1)}…`
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: NOTICE_SOURCE_KIND, form: 'notice', summary },
  }
}

/**
 * Deliver a late verification result into the agent's inbox.
 *
 * `agent.inject()` does not wake the agent, so the note waits for the next
 * admitted step instead of forcing an extra turn — exactly what a background
 * finding should do.
 *
 * @returns whether the note was handed to a live agent.
 */
function deliverNote(ctx, sessionId, text) {
  let agents = null
  try {
    agents = typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents
  } catch {
    agents = null
  }
  const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
  if (!agent || typeof agent.inject !== 'function') return false
  try {
    agent.inject(noticeMessage(text))
    return true
  } catch {
    return false
  }
}

/** Background probes that are still running, so tests can settle them. */
const inFlight = new Set()

/**
 * Run one verification without blocking the tool result, then inject the
 * finding. Deliberately does NOT receive the tool's abort signal: that signal
 * is aborted when the call finishes, which is the moment this work starts.
 *
 * @returns the tracking promise (already rejection-contained).
 */
function scheduleVerification(ctx, options, report, sources, entry, sessionId) {
  const gradeBefore = report.grade
  const promise = (async () => {
    const verification = await runVerification(ctx, options, report, sources, entry, null)
    if (!verification) return

    let gradeAfter = gradeBefore
    if (verification.kind === 'page' && verification.outcome === 'anchored') {
      const floor = verification.primaryLinks && verification.primaryLinks.length > 0 ? 'B' : 'C'
      gradeAfter = raiseGrade(gradeBefore, floor)
    }
    if (verification.kind === 'search' && verification.found === true) {
      gradeAfter = raiseGrade(gradeBefore, 'B')
    }

    verification.upgraded = gradeAfter !== gradeBefore
    verification.gradeAfter = gradeAfter
    const note = describeVerification(verification)
    if (note.length === 0) return

    const suffix = gradeAfter === gradeBefore
      ? `（本次结果集原判 ${gradeBefore}，结论不变）`
      : `（本次结果集由 ${gradeBefore} 上调至 ${gradeAfter}）`
    deliverNote(ctx, sessionId, `[来源审计·补证] ${note}${suffix}`)
  })().catch(() => {})

  inFlight.add(promise)
  promise.finally(() => inFlight.delete(promise))
  return promise
}

/** Resolve once every scheduled background probe has settled (tests only). */
export async function settleProbes() {
  await Promise.all([...inFlight])
}

/**
 * Register the annotation pass.
 *
 * @param ctx    the plugin context; registrations are fiber-scoped.
 * @param config the row's config, already normalized by `apply`.
 */
export function apply(ctx, config) {
  const baseConfig = config && typeof config === 'object' ? config : {}
  let options = resolveOptions(baseConfig)
  const currentOptions = () => {
    options = resolveOptions(baseConfig)
    return options
  }
  const memory = createMemory()

  if (options.enabled === false) return

  // `inject: ['tools']` guarantees the registry in a real host; the guard keeps
  // a host without tools (or a bare test context) from failing at apply time.
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    registerLedgerTool(ctx, memory, currentOptions)
    registerClaimTool(ctx, currentOptions)
  }
  registerLedgerRoute(ctx, memory, currentOptions)

  const annotate = async (exec, result, decision) => {
    if (!decision || decision.kind !== 'accept') return decision
    if (!exec || exec.name !== 'web_search') return decision
    if (!result || result.isError === true) return decision

    // Re-resolve here, not at apply time: the JSON config file is the tuning
    // surface and its next edit must apply to the next search, with no reload.
    const options = currentOptions()
    if (options.enabled === false) return decision

    const value = result.value
    if (!value || typeof value !== 'object') return decision
    const sources = value.sources
    if (!Array.isArray(sources) || sources.length === 0) return decision

    const sessionId = exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : 'default'
    const entry = memory.session(sessionId)

    const report = analyze(sources, options, { urls: entry.urls, titles: entry.titles })
    report.answered = typeof value.content === 'string' && value.content.trim().length > 0
    remember(entry, sources)
    recordQuery(sessionId, entry, report, sources)

    if (report.level === 'silent') return decision

    // Only verify what we are already willing to warn about: that is the whole
    // token-budget argument for probing late instead of on every search.
    // `verifyAll` widens this to every non-silent set (costlier, for diagnosis).
    const worthVerifying = options.verifyAll
      ? report.level !== 'silent'
      : report.level === 'full' && report.k <= 2

    let lastProbeMs = null
    if (options.verify && worthVerifying && !report.hasPrimary) {
      if (options.asyncVerify) {
        // Return the banner now; the probe's result arrives as an inbox note.
        const sessionId = exec.agent && typeof exec.agent.id === 'string' ? exec.agent.id : 'default'
        scheduleVerification(ctx, options, report, sources, entry, sessionId)
        report.verifyNote = '补证已转入后台，取回原文后会单独回填'
      } else {
        const verification = await runVerification(ctx, options, report, sources, entry, exec.signal)
        if (verification) {
          lastProbeMs = typeof verification.elapsedMs === 'number' ? verification.elapsedMs : null
          const gradeBefore = report.grade
          if (verification.kind === 'page' && verification.outcome === 'anchored') {
            const floor = verification.primaryLinks && verification.primaryLinks.length > 0 ? 'B' : 'C'
            report.grade = raiseGrade(report.grade, floor)
          }
          if (verification.kind === 'search' && verification.found === true) {
            report.grade = raiseGrade(report.grade, 'B')
          }
          verification.upgraded = report.grade !== gradeBefore
          verification.gradeAfter = report.grade
          // Failure kinds are honest but noisy; surface them only in debug mode.
          const noisy = verification.kind !== 'page' && verification.kind !== 'search'
          report.verifyNote = noisy && options.debug !== true
            ? ''
            : describeVerification(verification)
        }
      }
    }

    if (options.debug === true) {
      const probe = lastProbeMs === null ? '-' : lastProbeMs + 'ms'
      report.debugLine = `verify=${options.verify} verifyAll=${options.verifyAll}`
        + ` k=${report.k} probes=${entry.probes}/${options.maxProbes} probe=${probe}`
    }

    const block = render(report, options)
    if (block.length === 0) return decision

    const base = Array.isArray(decision.content)
      ? decision.content
      : Array.isArray(result.content) ? result.content : []

    return { ...decision, content: [{ type: 'text', text: block }, ...base] }
  }

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    try {
      return await annotate(exec, result, decision)
    } catch (error) {
      let debug = false
      try {
        debug = currentOptions().debug === true
      } catch {
        debug = false
      }
      if (debug) {
        console.warn('[provenance-guard] annotation skipped:', error && error.message ? error.message : error)
      }
      return decision
    }
  })
}
