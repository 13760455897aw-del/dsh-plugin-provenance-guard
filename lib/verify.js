/**
 * Verification helpers for the provenance audit: turning "this number has no
 * generating source" into "I looked, and here is what happened".
 *
 * Everything here is deterministic and cheap; the only network calls are made
 * by the caller (index.js) under its own budget.
 */

import { siteOf, isPrimarySite, authorityOf } from './audit.js'

/** Words that carry no fingerprint value. */
const STOP_TERMS = new Set([
  '数据', '显示', '报告', '今年', '去年', '目前', '最新', '相关', '表示',
  '认为', '指出', '已经', '可以', '我们', '他们', '这个', '那个', '如何',
  '为什么', '什么', '怎么', '全面', '持续', '同比', '环比',
])

/** Markers that a page describes how the number was produced. */
const METHOD_RE = /(样本|抽样|调查方法|统计口径|口径|数据来源|来源[:：]|方法学|问卷|置信区间|误差范围|n\s*=\s*\d+|万人样本)/

/** Markers that a page names an institution capable of producing the number. */
const INSTITUTION_RE = /(统计局|研究院|研究所|协会|学会|委员会|数据中心|大学|学院|部门|集团|公司|署|局|院)/

const URL_RE = /https?:\/\/[^\s"'<>）)]+/g

/**
 * Build the L2 fingerprint query: the quoted figure plus up to two content
 * terms. A quoted precise number is close to a unique key — a real figure has a
 * table behind it, a fabricated one only has echoes.
 *
 * @returns '' when there is no precise figure to anchor on.
 */
export function fingerprintQuery(number, title) {
  const figure = String(number || '').trim()
  if (figure.length === 0) return ''
  const terms = []
  const matches = String(title || '').match(/[\u4e00-\u9fa5]{2,8}|[A-Za-z][A-Za-z0-9]{2,}/g) || []
  for (const term of matches) {
    if (STOP_TERMS.has(term) || terms.includes(term)) continue
    terms.push(term)
    if (terms.length >= 2) break
  }
  return ['"' + figure + '"', ...terms].join(' ').trim()
}

/**
 * Strip markup and collapse whitespace so plain-text probes work on HTML pages.
 */
export function plainText(body) {
  if (!body || typeof body.content !== 'string') return ''
  let text = body.content
  if (body.kind === 'html') {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
  }
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Classify one fetched page against the figure it is supposed to be the origin of.
 *
 * @returns {{
 *   outcome: 'anchored'|'bland'|'mismatch'|'empty',
 *   hasNumber: boolean, hasInstitution: boolean, hasMethod: boolean,
 *   primaryLinks: string[], truncated: boolean,
 * }}
 */
export function inspectPage(page, number, extraPrimary = []) {
  const raw = page && page.body && typeof page.body.content === 'string' ? page.body.content : ''
  const text = plainText(page && page.body)
  const core = String(number || '').replace(/[%％]$/, '').trim()
  const hasNumber = core.length > 0 && text.includes(core)
  const hasInstitution = INSTITUTION_RE.test(text)
  const hasMethod = METHOD_RE.test(text)

  // Links live inside attributes, so they must be read from the raw markup,
  // not from the tag-stripped text.
  const primaryLinks = []
  for (const found of raw.match(URL_RE) || []) {
    const site = siteOf(found)
    if (site && isPrimarySite(site, extraPrimary) && !primaryLinks.includes(site)) primaryLinks.push(site)
    if (primaryLinks.length >= 3) break
  }

  let outcome = 'bland'
  if (!text) outcome = 'empty'
  else if (!hasNumber) outcome = 'mismatch'
  else if (hasInstitution || hasMethod || primaryLinks.length > 0) outcome = 'anchored'

  return {
    outcome,
    hasNumber,
    hasInstitution,
    hasMethod,
    primaryLinks,
    truncated: Boolean(page && page.truncated),
  }
}

/**
 * Choose the page most likely to be the origin of a collapsed cluster: the
 * earliest published member of the largest independent cluster.
 *
 * @returns '' when nothing suitable exists.
 */
export function pickOrigin(report, sources, extraPrimary = []) {
  const byUrl = new Map()
  for (const source of Array.isArray(sources) ? sources : []) {
    if (source && typeof source.url === 'string') byUrl.set(source.url, source)
  }
  const clusters = Array.isArray(report && report.clusters) ? report.clusters : []
  for (const cluster of clusters) {
    if (cluster.platform >= cluster.size) continue
    let best = ''
    let bestTime = Number.POSITIVE_INFINITY
    for (const url of cluster.urls || []) {
      const source = byUrl.get(url)
      if (!source) continue
      // Only an editorially responsible page can be the "origin" of a claim;
      // a self-media repost is downstream of it, not upstream.
      if (authorityOf(url, extraPrimary) !== 'media') continue
      const time = Date.parse(source.publishedAt || '')
      const stamp = Number.isNaN(time) ? Number.POSITIVE_INFINITY : time
      // `best === ''` matters: with no publishedAt every stamp is Infinity, and
      // `Infinity < Infinity` is false, so a sentinel-only comparison never
      // selects anything. Undated results are the common case, not the edge case.
      if (best === '' || stamp < bestTime) {
        bestTime = stamp
        best = url
      }
    }
    if (best) return best
  }
  return ''
}

/**
 * Look for a generative page among L2 search results. A hit requires both a
 * primary-domain site and the figure itself appearing in the snippet, so a
 * passing mention of a bureau does not count.
 */
export function inspectSearchResults(result, number, extraPrimary = []) {
  const core = String(number || '').replace(/[%％]$/, '').trim()
  const sources = result && Array.isArray(result.sources) ? result.sources : []
  for (const source of sources) {
    const site = siteOf(source.url)
    if (!site || !isPrimarySite(site, extraPrimary)) continue
    if (core.length > 0 && String(source.snippet || '').includes(core)) {
      return { found: true, url: source.url, title: source.title || site, site }
    }
  }
  return { found: false, scanned: sources.length }
}

/** Human-readable line for the audit block. */
export function describeVerification(result) {
  if (!result) return ''
  if (result.kind === 'page') {
    const where = result.site ? '（' + result.site + '）' : ''
    if (result.outcome === 'anchored') {
      const what = result.hasMethod ? '含口径/方法说明' : '提到生成机构'
      const after = result.gradeAfter || 'C'
      if (result.upgraded === false) return `补证：原文${where}${what}（等级维持 ${after}）`
      return `补证：原文${where}${what} → 等级上调至 ${after}`
    }
    if (result.outcome === 'mismatch') {
      return `补证：原文${where}未见该数字 → 可能是转述中被加上去的，维持 D`
    }
    if (result.outcome === 'empty') return ''
    return `补证：原文${where}提到该数字但未给出机构与口径 → 维持 D`
  }
  if (result.kind === 'search') {
    if (result.found) return `补证：检索到可能的生成源「${result.title || result.site}」${result.url}`
    return '补证：指纹检索未见生成机构，仅同批站点在转 → 维持 D'
  }
  if (result.kind === 'unavailable') return '补证不可用：web 服务未取到'
  if (result.kind === 'no-origin') return '补证未做：没有可回溯的原点'
  if (result.kind === 'no-number') return '补证未做：无精确数字可作指纹'
  if (result.kind === 'fetch-failed') {
    const where = result.site ? '（' + result.site + '）' : ''
    const why = result.error ? '：' + result.error : ''
    return `补证中断：取回原文${where}失败${why}`
  }
  if (result.kind === 'search-failed') {
    const why = result.error ? '：' + result.error : ''
    return `补证中断：指纹检索未返回结果${why}`
  }
  return ''
}
