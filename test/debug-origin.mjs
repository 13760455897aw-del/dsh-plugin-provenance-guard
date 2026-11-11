import { analyze } from '../lib/audit.js'
import { pickOrigin } from '../lib/verify.js'

// The exact result set from the live run where the probe reported
// "search-failed" with probes=2 and no page fetch — i.e. pickOrigin returned ''.
const sources = [
  { url: 'https://www.163.com/dy/article/L7BF9S7D0556HCRZ_pdya11y.html', title: '18.8万彩礼已成全国默认统一价？彩礼已成为国人的执念？', snippet: '18.8万彩礼成为讨论焦点。' },
  { url: 'http://mp.weixin.qq.com/s?__biz=MzYzMjA0MDcwMA==&mid=2247485025', title: '彩礼18.8万快成全国统一价了，可没人算过它的退货率', snippet: '彩礼18.8万。' },
  { url: 'https://www.sina.cn/news/detail/5345579788144585.html', title: '农科院调查报告农户彩礼均值降至3.86万', snippet: '报告称农户彩礼均值降至3.86万。' },
  { url: 'http://mp.weixin.qq.com/s?__biz=MzYyMjYzMzg4OA==&mid=2247486285', title: '18.8万彩礼全国统一价：是爱情在涨价，还是婚姻在贬值', snippet: '18.8万彩礼。' },
  { url: 'https://baike.baidu.com/item/%E4%B8%AD%E5%9B%BD%E5%BD%A9%E7%A4%BC%E5%9C%B0%E5%9B%BE/20439759?fr=aladdin&bst=1791387786', title: '中国彩礼地图', snippet: '各地彩礼金额。' },
  { url: 'http://mp.weixin.qq.com/s?__biz=MzYzNDE2MzMzNw==&mid=2247483843', title: '18.8万彩礼成全国统一价是假的，但没人愿意告诉你真的', snippet: '18.8万彩礼。' },
  { url: 'https://baike.baidu.com/item/%E4%B8%AD%E5%9B%BD%E5%BD%A9%E7%A4%BC%E5%9C%B0%E5%9B%BE/20439759?fr=aladdin&bst=1793277724', title: '中国彩礼地图', snippet: '各地彩礼金额。' },
  { url: 'https://www.toutiao.com/w/1876922784501824/', title: '你们那，现在结婚彩礼是多少钱？3.86万，农村彩礼的', snippet: '3.86万。' },
]

const report = analyze(sources)
console.log('k =', report.k, ' n =', report.n, ' platformCount =', report.platformCount, ' platformOnly =', report.platformOnly)
for (const [index, cluster] of report.clusters.entries()) {
  console.log(`cluster ${index}: size=${cluster.size} platform=${cluster.platform} sites=${cluster.sites.join(',')}`)
  console.log('   urls:', cluster.urls.join('\n         '))
}
console.log('\npickOrigin =', JSON.stringify(pickOrigin(report, sources)))
