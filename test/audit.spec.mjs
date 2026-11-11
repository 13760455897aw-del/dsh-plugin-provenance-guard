import assert from 'node:assert/strict'
import { analyze, render, siteOf, isPrimarySite, claimKey } from '../lib/audit.js'

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

console.log('\n== siteOf ==')
ok('www.google.com -> google.com', siteOf('https://www.google.com/x') === 'google.com', siteOf('https://www.google.com/x'))
ok('news.sina.com.cn -> sina.com.cn', siteOf('https://news.sina.com.cn/a') === 'sina.com.cn', siteOf('https://news.sina.com.cn/a'))
ok('www.gov.cn -> gov.cn', siteOf('https://www.gov.cn/a') === 'gov.cn', siteOf('https://www.gov.cn/a'))
ok('stats.gov.cn keeps label', siteOf('https://www.stats.gov.cn/a') === 'stats.gov.cn', siteOf('https://www.stats.gov.cn/a'))
ok('m.weibo.cn -> weibo.cn', siteOf('http://m.weibo.cn/x') === 'weibo.cn', siteOf('http://m.weibo.cn/x'))
ok('bbc.co.uk', siteOf('https://www.bbc.co.uk/news') === 'bbc.co.uk', siteOf('https://www.bbc.co.uk/news'))
ok('bad url -> empty', siteOf('not a url') === '', siteOf('not a url'))

console.log('\n== primary detection ==')
ok('stats.gov.cn primary', isPrimarySite('stats.gov.cn') === true)
ok('nature.com primary', isPrimarySite('nature.com') === true)
ok('random blog not primary', isPrimarySite('blog.example.com') === false)
ok('gov suffix', isPrimarySite('nasa.gov') === true)

console.log('\n== claimKey ==')
ok('uses precise number', claimKey('某产业占全球 73.6% 的份额') === '73.6%', claimKey('某产业占全球 73.6% 的份额'))
ok('text fallback', claimKey('没有任何数字的一句话').length > 0)

// ---------------------------------------------------------------------------
console.log('\n== case A: astroturfed statistic (expect full / D) ==')

const copy = '有数据显示，某产业已占全球 73.6% 的份额，稳居第一位，业内普遍看好。'
const caseA = []
const domainsA = ['a1-news.com', 'a2-daily.com', 'a3-post.com', 'a4-today.com', 'a5-times.com', 'a6-daily.com']
domainsA.forEach((domain, index) => {
  caseA.push({
    url: `https://${domain}/story/${index}`,
    title: '某产业占全球 73.6% 份额 稳居第一',
    snippet: copy,
    publishedAt: '2026-10-28T09:00:00Z',
  })
})
caseA.push({
  url: 'https://b1-media.com/x',
  title: '数据显示某产业份额达 73.2%',
  snippet: '据有关方面数据，该产业份额为 73.2%，较去年提升。',
  publishedAt: '2026-10-29T02:00:00Z',
})
caseA.push({
  url: 'https://b2-media.com/y',
  title: '该产业份额约 73.2%',
  snippet: '业内人士称份额为 73.2%。',
  publishedAt: '2026-10-29T03:00:00Z',
})
caseA.push({
  url: 'https://c1-blog.net/z',
  title: '某产业份额 74%',
  snippet: '综合报道，份额 74%，增长明显。',
  publishedAt: '2026-10-30T11:00:00Z',
})

const reportA = analyze(caseA)
console.log(render(reportA))
ok('collapses below source count', reportA.k < reportA.n, { k: reportA.k, n: reportA.n })
ok('at most 3 lineages', reportA.k <= 3, reportA.k)
ok('no primary source', reportA.hasPrimary === false)
ok('level is full', reportA.level === 'full', reportA.level)
ok('grade is D', reportA.grade === 'D', reportA.grade)
ok('numeric variants detected', reportA.numericVariants.length >= 2, reportA.numericVariants)

// ---------------------------------------------------------------------------
console.log('\n== case B: syndicated press release (expect K=1, brief) ==')

const release = { title: '某某公司今日发布新一代产品', snippet: '该公司表示新产品将面向企业客户开放，具体价格稍后公布。' }
const caseB = []
for (let i = 0; i < 10; i += 1) {
  caseB.push({ url: `https://wire${i}-news.com/p/${i}`, ...release, publishedAt: '2026-11-01T08:00:00Z' })
}
const reportB = analyze(caseB)
console.log(render(reportB))
ok('single lineage', reportB.k === 1, reportB.k)
ok('distinct sites', reportB.siteCount === 10, reportB.siteCount)
ok('not silent', reportB.level !== 'silent', reportB.level)
ok('grade D without primary', reportB.grade === 'D', reportB.grade)

// ---------------------------------------------------------------------------
console.log('\n== case C: healthy diverse results with a primary source (expect silent) ==')

const caseC = [
  { url: 'https://www.stats.gov.cn/sj/zxfb/2026.html', title: '2026年三季度行业运行情况', snippet: '国家统计局今日发布三季度行业运行数据，详见附表。', publishedAt: '2026-10-20T02:00:00Z' },
  { url: 'https://www.reuters.com/business/x', title: 'China industry output rises in third quarter', snippet: 'Output climbed, according to the statistics bureau release.', publishedAt: '2026-10-20T05:00:00Z' },
  { url: 'https://www.caixin.com/2026-10-20/x.html', title: '三季度行业运行数据发布', snippet: '统计局公布三季度数据，行业增速回升。', publishedAt: '2026-10-20T06:00:00Z' },
  { url: 'https://www.yicai.com/news/x.html', title: '行业三季度成绩单出炉', snippet: '从统计局数据看，行业运行总体平稳。', publishedAt: '2026-10-21T01:00:00Z' },
  { url: 'https://www.thepaper.cn/newsDetail_x', title: '三季度行业数据怎么看', snippet: '多位分析师解读统计局最新数据。', publishedAt: '2026-10-21T03:00:00Z' },
]
const reportC = analyze(caseC)
ok('silent on healthy set', reportC.level === 'silent', { level: reportC.level, score: reportC.score, k: reportC.k })
ok('has primary', reportC.hasPrimary === true)

// ---------------------------------------------------------------------------
console.log('\n== case C2: ordinary news carrying a figure, no primary (must not be full) ==')
const caseC2 = [
  { url: 'https://n1-post.com/1', title: '某市公布上半年经济数据', snippet: '该市上半年增长 5.2%，工业投资回升。', publishedAt: '2026-07-15T01:00:00Z' },
  { url: 'https://n2-daily.com/2', title: '多地公布半年报 增速分化', snippet: '从已公布数据看，区域间增速差异明显。', publishedAt: '2026-07-16T01:00:00Z' },
  { url: 'https://n3-review.com/3', title: '专家解读半年经济数据', snippet: '分析人士认为投资是主要拉动项。', publishedAt: '2026-07-17T01:00:00Z' },
  { url: 'https://n4-times.com/4', title: '上半年经济数据出炉', snippet: '多个城市陆续发布上半年运行情况。', publishedAt: '2026-07-18T01:00:00Z' },
]
const reportC2 = analyze(caseC2)
ok('not full on ordinary news', reportC2.level !== 'full', { level: reportC2.level, score: reportC2.score })
ok('grade C when 4 lineages, no drift', reportC2.grade === 'C', reportC2.grade)

// ---------------------------------------------------------------------------
console.log('\n== case G: real-world false alarm (48% vs 53.9% are different metrics) ==')
const caseG = [
  { url: 'https://cpcaauto.com/newslist.php?id=4142', title: '中国汽车流通协会乘用车市场信息联席分会', snippet: '乘联会发布月度分析。', publishedAt: '2026-01-26T02:00:00Z' },
  { url: 'http://www.news18a.com/news/storys_224363.html', title: '2025年新能源汽车产销破1600万辆，市占率近48%', snippet: '全年新能源汽车产销突破1600万辆，市占率接近48%。', publishedAt: '2026-01-26T03:00:00Z' },
  { url: 'http://finance.people.com.cn/BIG5/n1/2026/0126/c1004-40652981.html', title: '商务部：2025年新能源乘用车市场渗透率达到53.9%', snippet: '商务部发言人表示，新能源乘用车市场渗透率达到53.9%。', publishedAt: '2026-01-26T05:00:00Z' },
  { url: 'http://www.evobserver.com/archives/23716', title: '2025新能源车企集团排行榜', snippet: '比亚迪位居第一，小米小鹏零跑吉利增速较快。', publishedAt: '2026-01-27T01:00:00Z' },
  { url: 'https://finance.cnr.cn/jjgd/20260122/t20260122_527503239.shtml', title: '商务部：每售出10辆乘用车就有6辆是新能源车', snippet: '商务部介绍，截至2025年底每售出10辆乘用车就有6辆是新能源车。', publishedAt: '2026-01-22T02:00:00Z' },
  { url: 'http://siteapp.news18a.com/news/storys_222894.html', title: '乘联会：2025年乘用车零售2374.4万辆，同比增长3.8%', snippet: '乘用车零售2374.4万辆，同比增长3.8%。', publishedAt: '2026-01-26T04:00:00Z' },
  { url: 'https://m.12365auto.com/news/20260318/565096.shtml', title: '全球汽车电动化渗透率 中国只排第8', snippet: '全球电动化渗透率排名中，中国位列第八。', publishedAt: '2026-03-18T02:00:00Z' },
  { url: 'http://mp.weixin.qq.com/s?__biz=x', title: '2025年新能源厂商全年零售销量榜单公布', snippet: '比亚迪连续4年蝉联第一，小米汽车年度成绩411837辆。', publishedAt: '2026-01-28T02:00:00Z' },
]
const reportG = analyze(caseG)
console.log(render(reportG) || '(silent)')
ok('many lineages stay C', reportG.grade !== 'D', reportG.grade)
ok('not escalated to full by metric mismatch', reportG.level !== 'full', { level: reportG.level, score: reportG.score })
ok('no false drift', reportG.numericVariants.length === 0, reportG.numericVariants)

// ---------------------------------------------------------------------------
console.log('\n== case D: too few sources (expect silent) ==')
const reportD = analyze([{ url: 'https://a.com/1', title: 'only one' }])
ok('silent below minSources', reportD.level === 'silent' && reportD.reason === 'too-few-sources', reportD)

// ---------------------------------------------------------------------------
console.log('\n== case E: cross-query repetition boosts score ==')
const prior = {
  urls: new Set(),
  titles: new Map([['某产业占全球736份额稳居第一', 'a1-news.com']]),
}
const reportE = analyze(caseA, {}, prior)
ok('cross-site repeat detected', reportE.crossSiteRepeats.length > 0, reportE.crossSiteRepeats)

// ---------------------------------------------------------------------------
console.log('\n== case F: render respects maxBlockChars ==')
const long = render(reportA, { maxBlockChars: 120 })
ok('truncates', long.length <= 120, long.length)

// ---------------------------------------------------------------------------
console.log('\n== case H: institution recognition (v0.5) ==')
ok('association host from the curated table', isPrimarySite('cpcaauto.com') === true)
ok('org.cn institution label', isPrimarySite('sleep-society.org.cn') === true)
ok('plain org is not primary', isPrimarySite('example.org') === false)
ok('news org.cn stays media', isPrimarySite('news.org.cn') === false)

const institutionRelease = [
  { url: 'https://www.cpcaauto.com/news/1', title: '2025年新能源乘用车渗透率53.9%', snippet: '乘联会发布12月市场分析。', publishedAt: '2026-01-26T02:00:00Z' },
  { url: 'https://a1-news.com/x', title: '新能源乘用车渗透率53.9%', snippet: '乘联会公布，渗透率53.9%。', publishedAt: '2026-01-26T03:00:00Z' },
  { url: 'https://a2-news.com/y', title: '新能源乘用车渗透率53.9%', snippet: '据乘联会统计，渗透率53.9%。', publishedAt: '2026-01-26T04:00:00Z' },
  { url: 'https://a3-news.com/z', title: '新能源乘用车渗透率53.9%', snippet: '乘联会数据显示，渗透率53.9%。', publishedAt: '2026-01-26T05:00:00Z' },
]
const reportH = analyze(institutionRelease)
ok('association domain counts as a generator', reportH.hasPrimary === true, reportH.primarySites)
// One lineage plus its generator is B; A needs a second independent lineage.
ok('single lineage with a generator grades B', reportH.grade === 'B', reportH.grade)

const attributionOnly = [
  { url: 'https://b1-news.com/1', title: '新能源乘用车渗透率53.9%', snippet: '据乘联会数据，渗透率53.9%。', publishedAt: '2026-02-01T01:00:00Z' },
  { url: 'https://b2-news.com/2', title: '新能源乘用车渗透率53.9%', snippet: '据乘联会数据，渗透率53.9%。', publishedAt: '2026-02-01T02:00:00Z' },
  { url: 'https://b3-news.com/3', title: '新能源乘用车渗透率53.9%', snippet: '据乘联会数据，渗透率53.9%。', publishedAt: '2026-02-01T03:00:00Z' },
  { url: 'https://b4-news.com/4', title: '新能源乘用车渗透率53.9%', snippet: '据乘联会数据，渗透率53.9%。', publishedAt: '2026-02-01T04:00:00Z' },
]
const reportI = analyze(attributionOnly)
ok('single lineage with a named producer floors at C', reportI.grade === 'C', { grade: reportI.grade, k: reportI.k })
ok('report names the upstream', reportI.namedUpstream === '乘联会', reportI.namedUpstream)
ok('banner shows the named upstream', render(reportI).includes('具名上游'), render(reportI))

const mereMention = [
  { url: 'https://c1-news.com/1', title: '教育部长谈课后服务', snippet: '教育部部长在发布会上谈到了课后服务。', publishedAt: '2026-02-02T01:00:00Z' },
  { url: 'https://c2-news.com/2', title: '教育部长谈课后服务', snippet: '教育部部长在发布会上谈到了课后服务。', publishedAt: '2026-02-02T02:00:00Z' },
  { url: 'https://c3-news.com/3', title: '教育部长谈课后服务', snippet: '教育部部长在发布会上谈到了课后服务。', publishedAt: '2026-02-02T03:00:00Z' },
  { url: 'https://c4-news.com/4', title: '教育部长谈课后服务', snippet: '教育部部长在发布会上谈到了课后服务。', publishedAt: '2026-02-02T04:00:00Z' },
]
const reportJ = analyze(mereMention)
ok('a release verb is required, not a mere mention', reportJ.grade === 'D', { grade: reportJ.grade, named: reportJ.namedUpstream })

// ---------------------------------------------------------------------------
console.log('\n== case K: claim, origin and echoes reach the report ==')
const setK = [
  { url: 'https://a1-news.com/1', title: '某产业占全球73.6%份额', snippet: '有数据显示73.6%。', publishedAt: '2026-03-01T01:00:00Z' },
  { url: 'https://a2-news.com/2', title: '某产业占全球73.6%份额', snippet: '有数据显示73.6%。', publishedAt: '2026-03-01T03:00:00Z' },
  { url: 'https://a3-news.com/3', title: '某产业占全球73.6%份额', snippet: '有数据显示73.6%。', publishedAt: '2026-03-01T05:00:00Z' },
  { url: 'https://a4-news.com/4', title: '某产业占全球73.6%份额', snippet: '有数据显示73.6%。', publishedAt: '2026-03-01T07:00:00Z' },
]
const reportK = analyze(setK)
ok('claim is the precise number', reportK.claim === '73.6%', reportK.claim)
ok('origin is the earliest member', reportK.origin !== null && reportK.origin.site === 'a1-news.com', reportK.origin)
ok('echoes count the copies', reportK.echoes === setK.length - 1, reportK.echoes)
ok('no generator means not anchored', reportK.anchored === false, reportK.anchored)
const bannerK = render(reportK)
ok('banner names the origin', bannerK.includes('最早见于 a1-news.com'), bannerK)
ok('banner offers one pointer', /· 可核查：https:\/\//.test(bannerK), bannerK)

const setL = [
  { url: 'https://www.cpcaauto.com/news/9', title: '新能源乘用车渗透率53.9%', snippet: '乘联会发布月度分析，渗透率53.9%。', publishedAt: '2026-02-01T01:00:00Z' },
  { url: 'https://b1-news.com/1', title: '新能源乘用车渗透率53.9%', snippet: '乘联会公布，渗透率53.9%。', publishedAt: '2026-02-01T03:00:00Z' },
  { url: 'https://b2-news.com/2', title: '新能源乘用车渗透率53.9%', snippet: '乘联会公布，渗透率53.9%。', publishedAt: '2026-02-01T04:00:00Z' },
]
const reportL = analyze(setL)
ok('a generator carrying the figure anchors it', reportL.anchored === true, reportL.anchored)
ok('origin can be the generator itself', reportL.origin !== null && reportL.origin.site === 'cpcaauto.com', reportL.origin)
// A generator silences the banner, but the pointer stays on the report so the
// claim tool and the ledger can still cite it.
ok('report carries the generator URL', reportL.primaryUrl === 'https://www.cpcaauto.com/news/9', reportL.primaryUrl)
ok('a generator means no banner', render(reportL) === '', render(reportL))

// ---------------------------------------------------------------------------
console.log('\n== case M: an authority page that does not carry the figure ==')
const setM = [
  { url: 'https://www.stats.gov.cn/sj/zxfb/1.html', title: '2026年三季度行业运行情况', snippet: '国家统计局今日发布三季度数据，详见附表。', publishedAt: '2026-10-20T02:00:00Z' },
  { url: 'https://www.reuters.com/a', title: 'China industry output rises 6.8% in Q3', snippet: 'Output rose 6.8%, the statistics bureau said.', publishedAt: '2026-10-20T05:00:00Z' },
  { url: 'https://m1-news.com/b', title: '三季度工业增速6.8%', snippet: '统计局数据显示增速为6.8%。', publishedAt: '2026-10-20T06:00:00Z' },
  { url: 'https://m2-news.com/c', title: '三季度工业增速6.8%', snippet: '统计局数据显示增速为6.8%。', publishedAt: '2026-10-20T07:00:00Z' },
]
const reportM = analyze(setM)
ok('a generator still sets the grade ceiling', reportM.grade === 'A' || reportM.grade === 'B', reportM.grade)
ok('the mismatch is recorded', reportM.mismatchedPrimary === true, reportM.mismatchedPrimary)
const bannerM = render(reportM)
ok('the banner says the page lacks the figure', bannerM.includes('权威页未及该数字') || bannerM.includes('摘要里没有'), bannerM)

console.log('\n== case N: major newsrooms are named ==')
const setN = [
  { url: 'https://www.xinhuanet.com/a', title: '某产业全球份额达73.6%', snippet: '新华社报道，该产业份额已达73.6%。', publishedAt: '2026-04-01T01:00:00Z' },
  { url: 'https://www.caixin.com/b', title: '产业观察：份额持续走高', snippet: '财新网观察，该产业全球份额超过七成，业内看法不一。', publishedAt: '2026-04-01T02:00:00Z' },
  { url: 'https://mp.weixin.qq.com/s?x1', title: '某产业占全球73.6%', snippet: '有数据显示73.6%。', publishedAt: '2026-04-01T03:00:00Z' },
  { url: 'https://mp.weixin.qq.com/s?x2', title: '某产业占全球73.6%', snippet: '有数据显示73.6%。', publishedAt: '2026-04-01T04:00:00Z' },
  { url: 'https://mp.weixin.qq.com/s?x3', title: '某产业占全球73.6%', snippet: '有数据显示73.6%。', publishedAt: '2026-04-01T05:00:00Z' },
  { url: 'https://mp.weixin.qq.com/s?x4', title: '某产业占全球73.6%', snippet: '有数据显示73.6%。', publishedAt: '2026-04-01T06:00:00Z' },
]
const reportN = analyze(setN)
ok('major media are identified', reportN.majorMedia.includes('xinhuanet.com') && reportN.majorMedia.includes('caixin.com'), reportN.majorMedia)
const bannerN = render(reportN)
ok('the banner names the newsrooms', bannerN.includes('通讯社/大报'), bannerN)
ok('a serious-media set is still C, not A', reportN.grade === 'C', reportN.grade)

console.log(`\n${passed} checks passed\n`)
