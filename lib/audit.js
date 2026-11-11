/**
 * Provenance audit engine — deterministic, zero-dependency, no network, no LLM.
 *
 * It never decides whether a claim is true. It measures the SHAPE of the
 * evidence: how many independent lineages N sources actually collapse into,
 * whether any generative (primary) source is present, and whether attribution
 * breaks. Every output is derived from fields the search result already carries.
 */

/** Tunables; overridable from the plugin Config. */
export const DEFAULTS = {
  enabled: true,
  minSources: 3,
  maxBlockChars: 900,
  extraPrimaryHosts: [],
}

/** Subdomain labels that do not change the publisher. */
const SITE_PREFIX = ['www', 'm', 'amp', 'mobile', 'wap']

/** Multi-label public suffixes we care about (short, curated, not exhaustive). */
const MULTI_SUFFIX = new Set([
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'com.tw', 'com.au', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'co.jp', 'co.kr', 'com.sg', 'co.in', 'com.br', 'co.nz', 'com.mx',
])

/** Suffixes that mark a generative / instrumented source. */
const PRIMARY_SUFFIXES = ['gov', 'gov.cn', 'edu', 'edu.cn', 'ac.uk', 'ac.cn', 'int', 'mil']

/** Named generative hosts that the suffix rule misses. */
const PRIMARY_HOSTS = new Set([
  'who.int', 'un.org', 'worldbank.org', 'imf.org', 'oecd.org', 'europa.eu',
  'arxiv.org', 'doi.org', 'nature.com', 'science.org', 'thelancet.com', 'nejm.org',
  'ncbi.nlm.nih.gov', 'stats.gov.cn', 'pbc.gov.cn', 'mof.gov.cn', 'ndrc.gov.cn',
])

/**
 * Generative institutions whose own domain is a brand, not a suffix.
 *
 * An association's host is usually an acronym (`caam`, `cpca`), so no suffix
 * rule and no label rule can recognise it — only a curated entry can. Keep
 * this list strict: every entry turns a media-shaped site into "有一手源".
 */
const INSTITUTION_HOSTS = new Set([
  'cpcaauto.com', 'caam.org.cn', 'cninfo.com.cn', 'sse.com.cn', 'szse.cn',
  'csindex.com.cn', 'chinaclear.cn', 'chinabond.com.cn',
])

/** Domain labels that name a producing institution rather than a publisher. */
const INSTITUTIONAL_LABEL = /(?:^|[-.])(?:assoc|association|federation|chamber|society|institute|institut|academy|academia|council|union|guild)(?:[-.]|$)/i

/**
 * True for an `org`/`org.cn` host whose own label names an institution.
 *
 * The traffic this catches is `xxx-society.org.cn` and `xxx-institute.org`.
 * It is deliberately narrow: a bare `org` is a publisher of all kinds, so the
 * label itself has to be institutional.
 */
function isInstitutionalDomain(site) {
  const suffix = site.endsWith('.org.cn') ? '.org.cn' : site.endsWith('.org') ? '.org' : ''
  if (suffix.length === 0) return false
  return INSTITUTIONAL_LABEL.test(site.slice(0, -suffix.length))
}

/**
 * Institutions whose release a media item can honestly cite.
 *
 * Longer names come first so `国家统计局` wins over `统计局` and the banner
 * names the most specific producer it can.
 */
const INSTITUTION_NAMES = [
  '国家统计局', '中国人民银行', '人民银行', '海关总署', '工业和信息化部', '工信部',
  '财政部', '教育部', '国家卫健委', '卫健委', '国家医保局', '证监会',
  '国家能源局', '能源局', '农业农村部', '商务部', '人力资源和社会保障部', '人社部',
  '住房和城乡建设部', '住建部', '交通运输部', '民航局', '国铁集团',
  '中国汽车工业协会', '中汽协', '乘联会', '中国睡眠研究会', '中国信通院', '信通院',
  '中国社会科学院', '社科院', '中国科学院', '中科院', '统计局',
  '世界卫生组织', '世卫组织', '世界银行', '国际货币基金组织',
]

/** A producing institution is named as the actor behind the figure. */
const RELEASE_RE = /(发布|公布|通报|披露|公告|统计|报告|白皮书|调查|数据)/
const CITE_RE = /(据|来自|引自|援引|source:)[^。，；]{0,6}$/

/**
 * Name the institution a sentence attributes the figure to, or '' when none.
 *
 * Two shapes count: `据<机构>` (citation) and `<机构>发布/公布/…` (the release
 * itself). Merely mentioning an institution does not.
 */
function institutionAttribution(text) {
  const raw = String(text || '')
  for (const name of INSTITUTION_NAMES) {
    const at = raw.indexOf(name)
    if (at < 0) continue
    const before = raw.slice(Math.max(0, at - 8), at)
    const after = raw.slice(at + name.length, at + name.length + 14)
    if (CITE_RE.test(before) || RELEASE_RE.test(after)) return name
  }
  return ''
}

/** News agencies whose presence means the attribution chain names an upstream. */
const NAMED_UPSTREAM = [
  '新华社', '人民日报', '央视', '中新社', '中国青年报', '澎湃', '财新', '第一财经',
  '路透', '美联', '法新', '彭博', '联合早报', '华尔街日报', '纽约时报',
  'Reuters', 'Associated Press', 'AFP', 'Bloomberg', 'BBC', 'AP News', 'Xinhua',
]

/** Vague-attribution markers: "reports say" with nobody to point at. */
const ATTRIBUTION_RE = new RegExp([
  '据[^。，；]{0,10}(?:报道|消息|透露)',
  '有消息称', '知情人士', '消息人士', '据悉', '网传', '传闻',
  '综合[^。]{0,6}报道',
  'according to (?:reports|sources|officials)',
  'sources (?:said|say)', 'reportedly', 'it is reported',
].join('|'), 'i')

const YEAR_RE = /^(?:19|20)\d{2}$/
const NUM_RE = /\d[\d,]*(?:\.\d+)?\s*[%％]?/g
const QUOTE_RE = /[“"「『]([^“”"「」『』]{2,24})[”"」』]/g

/** Registrable site (eTLD+1-ish) for a URL, or '' when it is not parseable. */
export function siteOf(rawUrl) {
  let host = ''
  try {
    host = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
  host = host.replace(/\.$/, '')
  if (!host) return ''
  // Every WeChat public-account article is one publishing platform, not a site
  // of its own; collapsing it to qq.com would merge it with QQ News.
  if (host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com')) return 'weixin.qq.com'
  if (host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host
  const labels = host.split('.')
  while (labels.length > 2 && SITE_PREFIX.includes(labels[0])) labels.shift()
  if (labels.length <= 2) return labels.join('.')
  const last2 = labels.slice(-2).join('.')
  if (MULTI_SUFFIX.has(last2)) return labels.slice(-3).join('.')
  return labels.slice(-2).join('.')
}

/** True when the site is a generative source (records, filings, papers, releases). */
export function isPrimarySite(site, extra = []) {
  if (!site) return false
  if (Array.isArray(extra) && extra.includes(site)) return true
  if (PRIMARY_HOSTS.has(site)) return true
  if (INSTITUTION_HOSTS.has(site)) return true
  if (isInstitutionalDomain(site)) return true
  for (const suffix of PRIMARY_SUFFIXES) {
    if (site === suffix || site.endsWith('.' + suffix)) return true
  }
  return false
}

/**
 * Hosts that republish rather than produce: every item there is one persona's
 * post, not an institution's evidence. Ten WeChat articles are not ten sources.
 * Deliberately excludes portals with real editorial desks (sohu/163/qq news).
 */
const PLATFORM_HOSTS = [
  'mp.weixin.qq.com', 'weixin.qq.com',
  'toutiao.com', 'baijiahao.baidu.com',
  'zhihu.com', 'weibo.com', 'weibo.cn',
  'xiaohongshu.com', 'douyin.com', 'bilibili.com',
  'tieba.baidu.com', 'xueqiu.com', 'jianshu.com', 'douban.com',
]

/**
 * Newsrooms whose own reporting is evidence of editorial responsibility, even
 * though they generate nothing themselves. They do not upgrade a grade —
 * "a serious outlet reported it" is still C — but they are the difference
 * between "a claim copied by content farms" and "a claim reported by two
 * independent newsrooms", and the banner should say which one it is.
 */
const MAJOR_MEDIA = new Set([
  'xinhuanet.com', 'news.cn', 'people.com.cn', 'cctv.com', 'cnr.cn',
  'chinanews.com', 'chinadaily.com.cn', 'thepaper.cn', 'caixin.com',
  'yicai.com', 'jiemian.com', '21jingji.com', 'stcn.com', 'ce.cn',
  'gmw.cn', 'cyol.com', 'infzm.com', 'huanqiu.com', 'cgtn.com',
  'cls.cn', 'nbd.com.cn', 'reuters.com', 'apnews.com', 'bbc.com',
  'ft.com', 'wsj.com', 'nytimes.com', 'bloomberg.com', 'theguardian.com',
])

function isMajorMedia(site) {
  if (!site) return false
  if (MAJOR_MEDIA.has(site)) return true
  for (const host of MAJOR_MEDIA) if (site.endsWith('.' + host)) return true
  return false
}

/**
 * Three-tier authority used to decide what counts as independent evidence.
 *
 * @returns 'primary' (generative), 'platform' (self-media / UGC), or 'media'.
 */
export function authorityOf(rawUrl, extra = []) {
  const site = siteOf(rawUrl)
  if (!site) return 'media'
  if (isPrimarySite(site, extra)) return 'primary'
  let host = ''
  try {
    host = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return 'media'
  }
  for (const platform of PLATFORM_HOSTS) {
    if (host === platform || host.endsWith('.' + platform)) return 'platform'
  }
  return 'media'
}

function normText(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '')
}

function shingleSet(text, size) {
  const s = normText(text)
  const out = new Set()
  if (s.length < size) {
    if (s.length > 0) out.add(s)
    return out
  }
  for (let i = 0; i + size <= s.length; i += 1) out.add(s.slice(i, i + size))
  return out
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const token of a) if (b.has(token)) shared += 1
  return shared / (a.size + b.size - shared)
}

function isPreciseNumber(token) {
  const core = token.replace(/[%％]/g, '').replace(/\s+/g, '')
  if (YEAR_RE.test(core)) return false
  if (/\.\d/.test(core)) return true
  return core.replace(/[^\d]/g, '').length >= 4
}

/** Specific, hard-to-launder details: precise numbers and quoted phrases. */
function extractTokens(text) {
  const out = new Set()
  const raw = String(text || '')
  for (const match of raw.matchAll(NUM_RE)) {
    const token = match[0].replace(/,/g, '').replace(/\s+/g, '').replace(/％/g, '%')
    if (!isPreciseNumber(token)) continue
    out.add('n:' + token)
  }
  for (const match of raw.matchAll(QUOTE_RE)) {
    const phrase = match[1].trim().replace(/\s+/g, '')
    if (phrase.length >= 4) out.add('q:' + phrase)
  }
  return out
}

function hasNamedUpstream(text) {
  const raw = String(text || '')
  return NAMED_UPSTREAM.some(name => raw.includes(name))
}

function parseTime(value) {
  if (typeof value !== 'string' || value.length === 0) return Number.NaN
  const t = Date.parse(value)
  return Number.isNaN(t) ? Number.NaN : t
}

/** Normalized title identity, shared by analysis and session memory. */
export function titleKey(title) {
  return normText(title).replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40)
}

/**
 * Audit one search result set.
 *
 * @param sources  web_search `value.sources` ({url,title?,snippet?,publishedAt?})
 * @param options  tunables; see DEFAULTS
 * @param prior    session memory: { urls: Set<string>, titles: Map<string,string> }
 * @returns a report object; `level` is 'silent' | 'brief' | 'full'
 */
export function analyze(sources, options = {}, prior = {}) {
  const opts = { ...DEFAULTS, ...(options && typeof options === 'object' ? options : {}) }
  const items = []

  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || typeof source.url !== 'string' || source.url.length === 0) continue
    const site = siteOf(source.url)
    if (!site) continue
    const title = typeof source.title === 'string' ? source.title : ''
    const snippet = typeof source.snippet === 'string' ? source.snippet : ''
    items.push({
      url: source.url,
      site,
      title,
      snippet,
      text: `${title} ${snippet}`,
      publishedAt: typeof source.publishedAt === 'string' ? source.publishedAt : '',
      authority: authorityOf(source.url, opts.extraPrimaryHosts),
      tokens: extractTokens(`${title} ${snippet}`),
      titleShingles: shingleSet(title, 3),
      snippetShingles: shingleSet(snippet, 4),
      time: parseTime(source.publishedAt),
    })
  }

  const n = items.length
  if (n < opts.minSources) {
    return { level: 'silent', reason: 'too-few-sources', n, k: n, siteCount: new Set(items.map(i => i.site)).size }
  }

  // ---- union-find over independent-lineage edges --------------------------
  const parent = items.map((_, i) => i)
  const find = (x) => {
    let r = x
    while (parent[r] !== r) r = parent[r]
    while (parent[x] !== r) {
      const next = parent[x]
      parent[x] = r
      x = next
    }
    return r
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  const edgeReasons = { sameSite: 0, title: 0, snippet: 0, detail: 0 }

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = items[i]
      const b = items[j]
      if (a.site === b.site) {
        union(i, j)
        edgeReasons.sameSite += 1
        continue
      }
      if (jaccard(a.titleShingles, b.titleShingles) >= 0.8) {
        union(i, j)
        edgeReasons.title += 1
        continue
      }
      if (jaccard(a.snippetShingles, b.snippetShingles) >= 0.6) {
        union(i, j)
        edgeReasons.snippet += 1
        continue
      }
      let sharedDetail = 0
      for (const token of a.tokens) if (b.tokens.has(token)) sharedDetail += 1
      if (sharedDetail >= 1) {
        union(i, j)
        edgeReasons.detail += 1
      }
    }
  }

  const clustersByRoot = new Map()
  for (let i = 0; i < n; i += 1) {
    const root = find(i)
    if (!clustersByRoot.has(root)) clustersByRoot.set(root, [])
    clustersByRoot.get(root).push(items[i])
  }
  const clusters = [...clustersByRoot.values()].map(members => {
    const sites = [...new Set(members.map(m => m.site))]
    const times = members.map(m => m.time).filter(t => !Number.isNaN(t))
    return {
      size: members.length,
      sites,
      urls: members.map(m => m.url),
      platform: members.filter(m => m.authority === 'platform').length,
      hasPrimary: members.some(m => m.authority === 'primary'),
      earliest: times.length > 0 ? Math.min(...times) : null,
      // The earliest recoverable member is the closest thing to the source the
      // copy chain actually has. Without it a downgrade says "copies" but not
      // "copies of what".
      origin: (() => {
        const timed = members.filter(m => !Number.isNaN(m.time)).sort((a, b) => a.time - b.time)
        const first = timed[0] || members[0]
        if (!first) return null
        return {
          site: first.site,
          url: first.url,
          title: String(first.title || '').slice(0, 60),
          authority: first.authority,
          at: Number.isNaN(first.time) ? null : first.time,
        }
      })(),
    }
  })
  clusters.sort((a, b) => b.size - a.size)

  // A cluster made only of self-media posts is not evidence at all; a cluster
  // with at least one editorially responsible member is one independent lineage.
  const independentClusters = clusters.filter(cluster => cluster.platform < cluster.size)
  const platformOnly = clusters
    .filter(cluster => cluster.platform === cluster.size)
    .reduce((sum, cluster) => sum + cluster.size, 0)
  const independentN = n - platformOnly
  const k = independentClusters.length
  const siteCount = new Set(items.map(i => i.site)).size
  const platformCount = items.filter(i => i.authority === 'platform').length
  const hasPrimary = items.some(i => i.authority === 'primary')
  const maxCluster = independentClusters[0] || clusters[0]
  // ---- signal: numeric detail and drift -----------------------------------
  const numberSites = new Map()
  const percentSites = new Map()
  for (const item of items) {
    for (const token of item.tokens) {
      if (!token.startsWith('n:')) continue
      const key = token.slice(2)
      if (!numberSites.has(key)) numberSites.set(key, new Set())
      numberSites.get(key).add(item.site)
    }
    for (const match of `${item.title} ${item.snippet}`.matchAll(NUM_RE)) {
      const token = match[0].replace(/,/g, '').replace(/\s+/g, '').replace(/％/g, '%')
      if (!token.endsWith('%')) continue
      const value = Number.parseFloat(token)
      if (!Number.isFinite(value) || value <= 0) continue
      if (!percentSites.has(token)) percentSites.set(token, new Set())
      percentSites.get(token).add(item.site)
    }
  }
  const preciseNumbers = [...numberSites.entries()]
    .map(([token, sites]) => ({ token, sites: [...sites], count: sites.size }))
    .sort((a, b) => b.count - a.count)

  // Percentages close in magnitude describe one statistic; far apart are
  // different statistics and must not be read as disagreement. The 5% band is
  // deliberately tight: genuine re-tellings of one figure differ in the last
  // digits, while 48% (share of sales) and 53.9% (penetration rate) are simply
  // different measures and flagging them as drift is a false alarm.
  const percentTokens = [...percentSites.keys()].sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b))
  const families = []
  for (const token of percentTokens) {
    const value = Number.parseFloat(token)
    const group = families[families.length - 1]
    if (group && (value - group.min) / group.min <= 0.05) {
      group.tokens.push(token)
      group.precise = group.precise || token.includes('.')
    } else {
      families.push({ min: value, tokens: [token], precise: token.includes('.') })
    }
  }
  const driftedFamily = families.find(group => {
    if (group.tokens.length < 2 || !group.precise) return false
    // A telephone game needs at least two versions that each circulate beyond
    // one site; two outlets merely rounding differently is normal reporting.
    const multiSite = group.tokens.filter(token => (percentSites.get(token)?.size ?? 0) >= 2)
    return multiSite.length >= 2
  })
  const numericVariants = driftedFamily ? driftedFamily.tokens.slice(0, 4) : []

  // ---- signal: attribution breaks -----------------------------------------
  let attributionHits = 0
  let namedInstitution = ''
  for (const item of items) {
    const institution = institutionAttribution(item.text)
    if (institution.length > 0 && namedInstitution.length === 0) namedInstitution = institution
    if (!ATTRIBUTION_RE.test(item.text)) continue
    if (hasNamedUpstream(item.text) || institution.length > 0) continue
    attributionHits += 1
  }
  const attributionBroken = attributionHits >= Math.max(2, Math.ceil(n * 0.3))

  // A chain that names a real agency or institution is checkable even when the
  // origin's own page is absent; "we don't know who said it" is a different,
  // worse state.
  const upstreamNamed = items.some(item => hasNamedUpstream(item.text)) || namedInstitution.length > 0

  // ---- signal: cross-query repetition -------------------------------------
  const priorUrls = prior && prior.urls instanceof Set ? prior.urls : null
  const priorTitles = prior && prior.titles instanceof Map ? prior.titles : null
  let seenBefore = 0
  const crossSiteRepeats = []
  for (const item of items) {
    if (priorUrls && priorUrls.has(item.url)) seenBefore += 1
    if (!priorTitles) continue
    const key = titleKey(item.title)
    if (key.length < 6) continue
    const firstSite = priorTitles.get(key)
    if (typeof firstSite === 'string' && firstSite !== item.site) {
      crossSiteRepeats.push({ site: item.site, firstSite })
    }
  }

  // ---- diagnostics ---------------------------------------------------------
  const collapse = independentN > 1 ? 1 - k / independentN : (k === 0 ? 1 : 0)
  const attributionRate = Math.min(1, attributionHits / n)
  const drift = numericVariants.length > 0
  const score = Math.round(Math.min(1,
    0.45 * collapse + 0.20 * attributionRate + (drift ? 0.15 : 0)
    + (platformOnly >= 3 ? 0.15 : 0) + (crossSiteRepeats.length > 0 ? 0.05 : 0)) * 100) / 100

  // ---- what the set actually asserts ---------------------------------------
  // A grade answers "how strong is the evidence"; these answer "what is being
  // asserted, where did it first appear, does any generator carry it, and is
  // any of it a real newsroom rather than a repost". They are the difference
  // between a score and a usable answer.
  const claim = preciseNumbers.length > 0 ? preciseNumbers[0].token : ''
  const origin = maxCluster && maxCluster.origin ? maxCluster.origin : null
  const echoes = maxCluster ? Math.max(0, maxCluster.size - 1) : 0
  const anchored = claim.length > 0
    && items.some(item => item.authority === 'primary' && item.tokens.has('n:' + claim))
  const primaryItem = items.find(item => item.authority === 'primary')
  // An authority page that does not carry the figure is not evidence for it.
  // But a bulletin's title/snippet often omits the number it is the source of,
  // so membership in the claim's own cluster counts as carrying it: those
  // results folded together precisely because their text agrees.
  const primaryInMainCluster = primaryItem !== undefined
    && maxCluster !== undefined
    && Array.isArray(maxCluster.urls)
    && maxCluster.urls.includes(primaryItem.url)
  const primaryCarriesClaim = hasPrimary
    && (claim.length === 0 || anchored || primaryInMainCluster)
  const mismatchedPrimary = hasPrimary && !primaryCarriesClaim
  const majorMedia = [...new Set(
    items.filter(item => item.authority === 'media' && isMajorMedia(item.site)).map(item => item.site),
  )].slice(0, 3)

  // ---- warrant grade -------------------------------------------------------
  // Presence of a generator sets the ceiling; whether its snippet carries the
  // figure does not lower it (a bulletin's headline often omits the number it
  // publishes), but it is flagged in the banner so nobody cites it unread.
  let grade
  if (hasPrimary) grade = k >= 2 ? 'A' : 'B'
  else if (drift) grade = 'D'
  else if (k === 0) grade = 'D'
  else if (upstreamNamed) grade = 'C'
  else if (k === 1 && independentN >= 4) grade = 'D'
  else grade = 'C'

  // ---- how loud to be ------------------------------------------------------
  // Rules, not a weighted sum: each branch is a state a careful reader would
  // actually remark on. Anything else stays quiet — a banner on every search
  // trains the model to ignore banners.
  let level = 'silent'
  if (hasPrimary) {
    if (drift) level = 'full'
    // A government page in the results is not evidence for *this* figure when
    // the figure never appears on it; saying so once is worth the tokens.
    else if (mismatchedPrimary && claim.length > 0) level = 'brief'
  } else if (platformOnly === n) {
    level = 'brief'
  } else if (drift) {
    level = 'full'
  } else if (k === 0) {
    level = 'brief'
  } else if (k === 1) {
    level = n >= 4 ? 'full' : 'brief'
  } else if (k <= 2 && n >= 6) {
    level = 'full'
  } else if (platformCount >= 3 && platformCount / n >= 0.4) {
    // Self-media can fold into a cluster that also contains a real outlet, so
    // counting only all-platform clusters understates how much of this is reposts.
    level = 'brief'
  } else if (crossSiteRepeats.length > 0) {
    level = 'brief'
  }

  // ---- what the set actually asserts ---------------------------------------
  // Computed above, before the grade, because "does the authority carry the
  // figure" is what decides between A/B and C.

  return {
    n,
    k,
    independentN,
    platformOnly,
    platformCount,
    siteCount,
    hasPrimary,
    primarySites: [...new Set(items.filter(i => i.authority === 'primary').map(i => i.site))],
    primaryCarriesClaim,
    mismatchedPrimary,
    majorMedia,
    grade,
    score,
    level,
    claim,
    origin,
    echoes,
    anchored,
    primaryUrl: primaryItem ? primaryItem.url : '',
    clusters,
    maxClusterSize: maxCluster ? maxCluster.size : 0,
    maxClusterSites: maxCluster ? maxCluster.sites.length : 0,
    preciseNumbers: preciseNumbers.slice(0, 5),
    numericVariants,
    attributionHits,
    attributionBroken,
    namedUpstream: namedInstitution,
    seenBefore,
    crossSiteRepeats: crossSiteRepeats.slice(0, 3),
    edgeReasons,
    answered: false,
  }
}

/** Allowed speech act for a warrant grade. */
export const ACTION = {
  A: '可断言，注明来源，并可给出交叉印证',
  B: '可断言，须注明生成性来源（机构/文件/论文）',
  C: '仅可「据 X 报道」，不可去来源化',
  D: '仅可「有说法称…（未获独立证实）」，不可写成「数据显示」',
}

/** `MM-DD HH:MM` for a stored instant; '' when the source carried no date. */
function stampAt(at) {
  if (typeof at !== 'number' || !Number.isFinite(at)) return ''
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const pad = value => (value < 10 ? '0' : '') + String(value)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Render a report as the model-facing annotation block. '' when silent. */
export function render(report, options = {}) {
  const opts = { ...DEFAULTS, ...(options && typeof options === 'object' ? options : {}) }
  if (!report || report.level === 'silent') return ''

  const { n, k, siteCount, grade, hasPrimary } = report
  const action = ACTION[grade] || ACTION.D
  const platformOnly = report.platformOnly || 0
  const allPlatform = k === 0 && platformOnly > 0

  const extra = []
  if (typeof report.verifyNote === 'string' && report.verifyNote.length > 0) extra.push('· ' + report.verifyNote)
  if (typeof report.debugLine === 'string' && report.debugLine.length > 0) extra.push('· 调试：' + report.debugLine)
  const extraText = extra.length > 0 ? '\n' + extra.join('\n') : ''

  if (report.level === 'brief') {
    if (allPlatform) {
      return `[来源审计] ${n} 条结果全部来自自媒体/聚合平台，不构成独立来源（域名无法区分机构官方账号）\n→ ${grade} 级：${action}${extraText}`
    }
    const bits = [`[来源审计] ${n} 条结果 → 仅 ${k} 条独立来源谱系（${siteCount} 个站点）`]
    bits.push(report.primaryCarriesClaim
      ? '有一手源'
      : report.mismatchedPrimary ? '权威页未及该数字' : '无一手源')
    const platformCount = report.platformCount || 0
    if (platformCount > 0) bits.push(`其中 ${platformCount} 条为自媒体`)
    const majors = Array.isArray(report.majorMedia) ? report.majorMedia : []
    if (majors.length > 0) bits.push(`含 ${majors.length} 家大媒体`)
    if (report.numericVariants.length > 0) bits.push(`数字不一致：${report.numericVariants.join(' / ')}`)
    if (report.origin) bits.push(`最早见于 ${report.origin.site}`)
    return `${bits.join('｜')}\n→ ${grade} 级：${action}${extraText}`
  }

  const lines = []
  const claimPart = report.claim ? `主张「${report.claim}」｜` : ''
  const primaryLabel = report.primaryCarriesClaim
    ? '有一手源'
    : report.mismatchedPrimary ? '权威页未及该数字' : '无一手源'
  lines.push(`[来源审计] ${claimPart}K=${k}｜N=${n}｜${primaryLabel}｜${grade} 级`)

  if (report.origin && !allPlatform) {
    const when = stampAt(report.origin.at)
    const echo = report.echoes === 0
      ? '没有其它站点转述'
      : `其后 ${report.echoes} 条为同源转述`
    lines.push(`· 出处：最早见于 ${report.origin.site}${when ? `（${when}）` : ''}，${echo}`)
  }

  if (allPlatform) {
    lines.push(`· 平台：${n} 条全部来自自媒体/聚合平台，不计入独立来源`)
  } else {
    const foldNote = report.maxClusterSize >= 3
      ? `；最大谱系 ${report.maxClusterSize} 条（${report.maxClusterSites} 个站点，内容高度重合）`
      : ''
    lines.push(`· 折叠：${n} 条 / ${siteCount} 个站点 → ${k} 条独立谱系${foldNote}`)
  }

  const platformCount = report.platformCount || 0
  if (platformCount > 0 && !allPlatform) {
    lines.push(`· 平台：${platformCount}/${n} 条来自自媒体/聚合平台，单条不构成独立来源`)
  }

  const majors = Array.isArray(report.majorMedia) ? report.majorMedia : []
  if (majors.length > 0 && !allPlatform) {
    lines.push(`· 媒体：含 ${majors.length} 家通讯社/大报（${majors.slice(0, 2).join('、')}），属媒体转述而非内容农场`)
  }

  if (report.primaryCarriesClaim) {
    lines.push(`· 锚点：生成方命中该数字（${report.primarySites.slice(0, 2).join('、')}）`)
  } else if (report.mismatchedPrimary) {
    const which = report.claim ? `标题/摘要里没有「${report.claim}」` : '标题/摘要里没有这个主张'
    lines.push(`· 注意：结果集含权威页面（${report.primarySites.slice(0, 2).join('、')}），但${which}，不能算一手源`)
  } else if (report.preciseNumbers.length > 0) {
    const top = report.preciseNumbers[0]
    lines.push(`· 锚点：未找到「${top.token}」的生成机构或原始表（该数字见于 ${top.count} 个站点）`)
  } else {
    lines.push('· 锚点：无精确数字可核')
  }

  if (report.numericVariants.length > 0) {
    lines.push(`· 漂移：同一指标存在多个版本 ${report.numericVariants.join(' / ')}`)
  }
  if (report.attributionHits > 0) {
    lines.push(`· 署名：${report.attributionHits}/${n} 条仅转述（「据报道」类），无具名上游`)
  }
  // Only when the generator itself is missing: saying "no original seen" beside
  // a row that already lists a primary source would contradict the anchor line.
  if (!report.primaryCarriesClaim && typeof report.namedUpstream === 'string' && report.namedUpstream.length > 0) {
    lines.push(`· 署名：具名上游「${report.namedUpstream}」（未见其原文）`)
  }
  if (report.crossSiteRepeats.length > 0) {
    const first = report.crossSiteRepeats[0]
    lines.push(`· 复现：同一标题在前序检索已出现于 ${first.firstSite}，本次再现于 ${first.site}`)
  }
  // One pointer is worth more than a verdict: the first page in the chain, or
  // the generator when the chain has one.
  const pointer = report.primaryUrl || (report.origin && report.origin.url) || ''
  if (pointer.length > 0) lines.push(`· 可核查：${pointer}`)
  if (report.answered) {
    lines.push('· 摘要：由检索服务生成，非独立证据')
  }
  if (typeof report.verifyNote === 'string' && report.verifyNote.length > 0) {
    lines.push('· ' + report.verifyNote)
  }
  if (typeof report.debugLine === 'string' && report.debugLine.length > 0) {
    lines.push('· 调试：' + report.debugLine)
  }
  lines.push(`→ ${grade} 级：${action}`)

  let text = lines.join('\n')
  if (text.length > opts.maxBlockChars) text = text.slice(0, opts.maxBlockChars - 1) + '…'
  return text
}

/** Deterministic key for a claim family, used to cap repeated probes. */
export function claimKey(text) {
  const numbers = []
  for (const match of String(text || '').matchAll(NUM_RE)) {
    const token = match[0].replace(/,/g, '').replace(/\s+/g, '')
    if (isPreciseNumber(token)) numbers.push(token)
  }
  return numbers.length > 0 ? numbers.slice(0, 3).sort().join('|') : normText(text).slice(0, 32)
}

/** First precise number in free text, normalized; '' when the text has none. */
export function firstPreciseNumber(text) {
  for (const match of String(text || '').matchAll(NUM_RE)) {
    const token = match[0].replace(/,/g, '').replace(/\s+/g, '').replace(/％/g, '%')
    if (isPreciseNumber(token)) return token
  }
  return ''
}
