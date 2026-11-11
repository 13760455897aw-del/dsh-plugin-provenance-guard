import { analyze } from '../lib/audit.js'
import {
  describeVerification,
  fingerprintQuery,
  inspectPage,
  inspectSearchResults,
  pickOrigin,
  plainText,
} from '../lib/verify.js'

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

console.log('\n== fingerprintQuery ==')
ok('quotes the figure', fingerprintQuery('73.6%', '某产业占全球73.6%份额 稳居第一').startsWith('"73.6%"'),
  fingerprintQuery('73.6%', '某产业占全球73.6%份额 稳居第一'))
ok('adds content terms', fingerprintQuery('73.6%', '某产业占全球73.6%份额 稳居第一').split(' ').length >= 2,
  fingerprintQuery('73.6%', '某产业占全球73.6%份额 稳居第一'))
ok('empty without figure', fingerprintQuery('', '某产业占全球份额') === '')
ok('english title works', fingerprintQuery('6.8%', 'China industry output rises 6.8% in Q3').includes('"6.8%"'),
  fingerprintQuery('6.8%', 'China industry output rises 6.8% in Q3'))

console.log('\n== plainText ==')
ok('strips html', plainText({ kind: 'html', content: '<p>hello <b>world</b></p>' }) === 'hello world',
  plainText({ kind: 'html', content: '<p>hello <b>world</b></p>' }))
ok('drops scripts', !plainText({ kind: 'html', content: '<script>evil()</script>ok' }).includes('evil'))
ok('handles missing body', plainText(undefined) === '')

console.log('\n== inspectPage ==')
const anchoredPage = {
  statusCode: 200,
  truncated: false,
  body: {
    kind: 'html',
    content: '<html><body><h1>2026年三季度数据</h1><p>国家统计局发布，本次调查样本为6万户，采用抽样方法。</p>'
      + '<p>该指标为23.7%，详见附表。</p></body></html>',
  },
}
const anchored = inspectPage(anchoredPage, '23.7%')
ok('anchored when institution+method present', anchored.outcome === 'anchored', anchored)
ok('detects method', anchored.hasMethod === true)
ok('detects institution', anchored.hasInstitution === true)

const blandPage = {
  statusCode: 200,
  truncated: false,
  body: { kind: 'text', content: '有数据显示，该指标为23.7%，业内普遍看好。' },
}
const bland = inspectPage(blandPage, '23.7%')
ok('bland when number but no anchor', bland.outcome === 'bland', bland)

const mismatchPage = {
  statusCode: 200,
  truncated: false,
  body: { kind: 'text', content: '该指标表现平稳，市场情绪回暖。' },
}
const mismatch = inspectPage(mismatchPage, '23.7%')
ok('mismatch when number absent', mismatch.outcome === 'mismatch', mismatch)

const emptyPage = { statusCode: 404, truncated: false, body: { kind: 'text', content: '' } }
ok('empty page', inspectPage(emptyPage, '23.7%').outcome === 'empty')

const linkedPage = {
  statusCode: 200,
  truncated: false,
  body: { kind: 'html', content: '<p>23.7%</p><a href="https://www.stats.gov.cn/x">原始表</a>' },
}
const linked = inspectPage(linkedPage, '23.7%')
ok('detects primary link', linked.primaryLinks.includes('stats.gov.cn'), linked.primaryLinks)

console.log('\n== inspectSearchResults ==')
const searchHit = inspectSearchResults({
  sources: [
    { url: 'https://random-blog.com/a', title: 'blog', snippet: '份额 73.6%' },
    { url: 'https://www.stats.gov.cn/sj/x.html', title: '统计公报', snippet: '该指标为 73.6%' },
  ],
}, '73.6%')
ok('finds primary hit', searchHit.found === true && searchHit.site === 'stats.gov.cn', searchHit)

const searchMiss = inspectSearchResults({
  sources: [{ url: 'https://a-news.com/1', title: 'a', snippet: '73.6%' }],
}, '73.6%')
ok('miss without primary', searchMiss.found === false, searchMiss)

const searchPrimaryNoNumber = inspectSearchResults({
  sources: [{ url: 'https://www.stats.gov.cn/sj/x.html', title: '公报', snippet: '统计公报发布' }],
}, '73.6%')
ok('primary without the figure is not a hit', searchPrimaryNoNumber.found === false, searchPrimaryNoNumber)

console.log('\n== pickOrigin ==')
const sourcesForOrigin = [
  { url: 'https://a-news.com/1', title: '某产业占全球73.6%份额', snippet: '有数据显示73.6%。', publishedAt: '2026-10-29T02:00:00Z' },
  { url: 'https://b-daily.com/2', title: '某产业占全球73.6%份额', snippet: '有数据显示73.6%。', publishedAt: '2026-10-28T02:00:00Z' },
  { url: 'https://mp.weixin.qq.com/s?x', title: '某产业占全球73.6%份额', snippet: '有数据显示73.6%。', publishedAt: '2026-10-27T02:00:00Z' },
]
const reportForOrigin = analyze(sourcesForOrigin)
const origin = pickOrigin(reportForOrigin, sourcesForOrigin)
ok('picks the earliest non-platform copy', origin === 'https://b-daily.com/2', origin)

// Regression: live result sets usually carry no publishedAt at all. With a
// sentinel-only comparison every stamp is Infinity and nothing is ever picked.
{
  const undated = [
    { url: 'https://www.163.com/dy/article/x.html', title: '某产业占全球73.6%份额', snippet: '有数据显示73.6%。' },
    { url: 'http://mp.weixin.qq.com/s?a', title: '某产业占全球73.6%份额', snippet: '有数据显示73.6%。' },
    { url: 'http://mp.weixin.qq.com/s?b', title: '某产业占全球73.6%份额', snippet: '有数据显示73.6%。' },
  ]
  const undatedOrigin = pickOrigin(analyze(undated), undated)
  ok('picks an origin when nothing is dated', undatedOrigin === 'https://www.163.com/dy/article/x.html', undatedOrigin)
}

console.log('\n== describeVerification ==')
ok('anchored note', describeVerification({ kind: 'page', outcome: 'anchored', site: 'a.com', hasMethod: true }).includes('上调至 C'))
ok('mismatch note', describeVerification({ kind: 'page', outcome: 'mismatch', site: 'a.com' }).includes('未见该数字'))
ok('bland note', describeVerification({ kind: 'page', outcome: 'bland', site: 'a.com' }).includes('维持 D'))
ok('search hit note carries url',
  describeVerification({ kind: 'search', found: true, url: 'https://x.gov.cn/a', title: '表' }).includes('https://x.gov.cn/a'))
ok('search miss note', describeVerification({ kind: 'search', found: false }).includes('维持 D'))
ok('unavailable note', describeVerification({ kind: 'unavailable' }).includes('不可用'))
ok('fetch-failed note', describeVerification({ kind: 'fetch-failed', site: 'a.com' }).includes('取回原文'))
ok('search-failed note', describeVerification({ kind: 'search-failed' }).includes('未返回结果'))
ok('no-origin note', describeVerification({ kind: 'no-origin' }).includes('原点'))
ok('no-number note', describeVerification({ kind: 'no-number' }).includes('指纹'))
ok('null yields empty', describeVerification(null) === '')

console.log(`\n${passed} checks passed\n`)
