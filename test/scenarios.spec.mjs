import { analyze, render } from '../lib/audit.js'

/**
 * Scenario matrix: what a careful human would conclude, versus what the engine
 * concludes. Expectations here are the human judgement, not the engine's —
 * a FAIL means the engine's logic disagrees with the documented reasoning.
 */

const src = (url, title, snippet, publishedAt) => ({ url, title, snippet, publishedAt })

const cases = [
  // ---- 组 1：数字不同但合法 ------------------------------------------------
  {
    id: 'S01',
    name: '不同统计口径（乘用车口径 48% vs 渗透率 53.9%）',
    why: '两个不同指标，不是同一数字的两个版本',
    expect: { level: 'silent', grade: 'any' },
    sources: [
      src('https://cpcaauto.com/a', '乘联会：2025年新能源乘用车零售占比近48%', '乘联会数据显示，新能源乘用车零售占比接近48%。', '2026-01-26T02:00:00Z'),
      src('http://finance.people.com.cn/x', '商务部：新能源乘用车市场渗透率达53.9%', '商务部表示市场渗透率达到53.9%。', '2026-01-26T05:00:00Z'),
      src('https://finance.cnr.cn/y', '商务部：每售出10辆乘用车就有6辆是新能源', '商务部介绍相关情况。', '2026-01-22T02:00:00Z'),
      src('https://www.yicai.com/z', '新能源车渗透率怎么看', '多位分析师给出解读。', '2026-01-27T02:00:00Z'),
    ],
  },
  {
    id: 'S02',
    name: '不同年份（2024 年 1200 万辆 vs 2025 年 1600 万辆）',
    why: '年份不同，数据不同是正常的',
    expect: { level: 'silent', grade: 'any' },
    sources: [
      src('https://a-news.com/1', '2024年新能源汽车销量1200万辆', '全年销量1200万辆，同比增长明显。', '2025-01-10T02:00:00Z'),
      src('https://b-daily.com/2', '2025年新能源汽车销量1600万辆', '全年销量1600万辆，再创新高。', '2026-01-10T02:00:00Z'),
      src('https://c-post.com/3', '两年销量对比：从1200万到1600万', '销量从1200万辆增长到1600万辆。', '2026-01-11T02:00:00Z'),
      src('https://d-times.com/4', '新能源车年销量连续增长', '行业销量持续攀升。', '2026-01-12T02:00:00Z'),
    ],
  },
  {
    id: 'S03',
    name: '不同地区（全国 48% vs 广东 55%）',
    why: '地域范围不同，数值不可比',
    expect: { level: 'silent', grade: 'any' },
    sources: [
      src('https://a-news.com/1', '全国新能源渗透率48%', '全国口径为48%。', '2026-02-01T02:00:00Z'),
      src('https://b-daily.com/2', '广东新能源渗透率55%', '广东口径为55%，高于全国。', '2026-02-02T02:00:00Z'),
      src('https://c-post.com/3', '各省新能源渗透率差异明显', '区域差异较大。', '2026-02-03T02:00:00Z'),
      src('https://d-times.com/4', '广东为何渗透率更高', '充电设施密度更高。', '2026-02-04T02:00:00Z'),
    ],
  },
  {
    id: 'S04',
    name: '不同机构各自调查（6.85 小时 vs 7.06 小时）',
    why: '两份独立调查，抽样与口径不同，数值接近但不相等',
    expect: { level: 'silent', grade: 'any' },
    sources: [
      src('https://k.sina.cn/a', '2025睡眠报告：国民平均睡6.85小时', '调查显示平均睡眠6.85小时。', '2025-03-21T02:00:00Z'),
      src('https://m.gmw.cn/b', '世界睡眠日：我国国民每晚平均睡6.85小时', '相关调查结果为6.85小时。', '2025-03-21T03:00:00Z'),
      src('https://news.ifeng.com/c', '报告：18岁及以上人群平均睡眠7.06—7.18小时', '另一份报告给出的区间为7.06至7.18小时。', '2025-06-10T02:00:00Z'),
      src('https://www.jingjiribao.cn/d', '你的睡眠达标了吗', '多份报告数据略有差异。', '2025-06-11T02:00:00Z'),
    ],
  },
  {
    id: 'S05',
    name: '不同筛选类别（线上 30% vs 全渠道 22%）',
    why: '统计范围不同，差异是真实的',
    expect: { level: 'silent', grade: 'any' },
    sources: [
      src('https://a-news.com/1', '线上渠道占比30%', '仅统计线上渠道为30%。', '2026-03-01T02:00:00Z'),
      src('https://b-daily.com/2', '全渠道占比22%', '全渠道口径为22%。', '2026-03-02T02:00:00Z'),
      src('https://c-post.com/3', '口径不同结论差很多', '线上与全渠道差异明显。', '2026-03-03T02:00:00Z'),
      src('https://d-times.com/4', '如何理解这两个数', '需注意统计范围。', '2026-03-04T02:00:00Z'),
    ],
  },

  // ---- 组 2：数字相同、说法不同 ------------------------------------------
  {
    id: 'S06',
    name: '同一数字，五家媒体措辞迥异',
    why: '措辞不同不产生独立证据，仍是一条谱系',
    expect: { level: 'full', grade: 'D' },
    sources: [
      src('https://a-news.com/1', '重磅：这个行业已占全球七成以上', '该产业占全球73.6%的份额。', '2026-10-28T02:00:00Z'),
      src('https://b-daily.com/2', '中国制造再下一城', '数据显示占全球73.6%份额。', '2026-10-28T05:00:00Z'),
      src('https://c-post.com/3', '七成份额意味着什么', '目前份额为73.6%。', '2026-10-29T02:00:00Z'),
      src('https://d-times.com/4', '全球第一，靠的是什么', '份额达到73.6%。', '2026-10-29T03:00:00Z'),
      src('https://e-review.com/5', '这个数字值得警惕', '份额73.6%背后。', '2026-10-30T02:00:00Z'),
    ],
  },
  {
    id: 'S07',
    name: '中英双语报道同一数字',
    why: '跨语言转载仍是同一来源',
    expect: { level: 'full', grade: 'D' },
    sources: [
      src('https://a-news.cn/1', '某产业占全球73.6%份额', '该产业份额为73.6%。', '2026-10-28T02:00:00Z'),
      src('https://b-daily.cn/2', '份额达73.6% 稳居第一', '数据显示份额73.6%。', '2026-10-28T04:00:00Z'),
      src('https://c-post.com/3', 'China accounts for 73.6% of global output', 'The share reached 73.6% of global output.', '2026-10-28T06:00:00Z'),
      src('https://d-times.com/4', 'Industry share hits 73.6 percent', 'Output share stood at 73.6%.', '2026-10-29T02:00:00Z'),
    ],
  },
  {
    id: 'S08',
    name: '同一数字，但都明确署名「据新华社」',
    why: '链条指向具名机构，可核查，不应判「不知谁说」',
    expect: { level: 'full', grade: 'C' },
    sources: [
      src('https://a-news.com/1', '据新华社报道 某产业份额73.6%', '据新华社报道，该产业份额为73.6%。', '2026-10-28T02:00:00Z'),
      src('https://b-daily.com/2', '新华社：份额达73.6%', '据新华社消息，份额达到73.6%。', '2026-10-28T04:00:00Z'),
      src('https://c-post.com/3', '转新华社 产业份额七成三', '据新华社报道，份额73.6%。', '2026-10-28T06:00:00Z'),
      src('https://d-times.com/4', '新华社报道引发关注', '据新华社报道，该数字为73.6%。', '2026-10-29T02:00:00Z'),
      src('https://e-review.com/5', '解读新华社这篇报道', '报道提到份额73.6%。', '2026-10-29T03:00:00Z'),
    ],
  },

  // ---- 组 3：真实漂移 ------------------------------------------------------
  {
    id: 'S09',
    name: '无锚数字多版本流传（73.6 / 73.2 / 74）',
    why: '同一指标三个版本，且没有任何生成机构',
    expect: { level: 'full', grade: 'D' },
    sources: [
      src('https://a-news.com/1', '某产业占全球73.6%份额', '有数据显示占比73.6%。', '2026-10-28T02:00:00Z'),
      src('https://b-daily.com/2', '某产业占全球73.6%份额', '有数据显示占比73.6%。', '2026-10-28T03:00:00Z'),
      src('https://c-post.com/3', '某产业占全球73.6%份额', '有数据显示占比73.6%。', '2026-10-28T04:00:00Z'),
      src('https://d-times.com/4', '数据显示该产业份额73.2%', '据有关方面数据，份额73.2%。', '2026-10-29T02:00:00Z'),
      src('https://e-review.com/5', '该产业份额约73.2%', '业内人士称份额73.2%。', '2026-10-29T03:00:00Z'),
      src('https://f-blog.net/6', '某产业份额74%', '综合报道，份额74%。', '2026-10-30T02:00:00Z'),
    ],
  },

  // ---- 组 4：一手源 --------------------------------------------------------
  {
    id: 'S10',
    name: '政府统计公报原文 + 媒体转引',
    why: '有生成性来源且多条独立谱系，A 级',
    expect: { level: 'any', grade: 'A' },
    sources: [
      src('https://www.stats.gov.cn/sj/zxfb/2026.html', '2026年三季度行业运行情况', '国家统计局今日发布三季度数据，详见附表。', '2026-10-20T02:00:00Z'),
      src('https://www.reuters.com/a', 'China industry output rises 6.8% in Q3', 'Output rose 6.8%, the statistics bureau said.', '2026-10-20T05:00:00Z'),
      src('https://www.caixin.com/b', '三季度工业增速6.8%', '统计局数据显示增速为6.8%。', '2026-10-20T06:00:00Z'),
      src('https://www.yicai.com/c', '三季度数据出炉', '统计局公布三季度数据。', '2026-10-21T01:00:00Z'),
    ],
  },
  {
    id: 'S11',
    name: '学术论文原文出现在结果里',
    why: '论文是生成性来源且谱系独立，A 级',
    expect: { level: 'any', grade: 'A' },
    sources: [
      src('https://arxiv.org/abs/2402.07867', 'PoisonedRAG: Knowledge Poisoning Attacks to RAG', 'We show that injecting a small number of texts can corrupt answers.', '2024-02-12T02:00:00Z'),
      src('https://www.nature.com/articles/x', 'Detecting hallucinations using semantic entropy', 'We propose semantic entropy for detecting confabulation.', '2024-06-19T02:00:00Z'),
      src('https://news.example.com/a', '研究发现检索系统易被少量文本污染', '该论文指出注入少量文本即可影响结果。', '2024-02-13T02:00:00Z'),
    ],
  },
  {
    id: 'S12',
    name: '只有媒体转述论文，论文本身不在结果里',
    why: '没有一手源但有多条独立报道，应为 C（须署名）',
    expect: { level: 'any', grade: 'C' },
    sources: [
      src('https://a-news.com/1', '研究称AI检索易被污染', '一项研究指出检索系统易被少量文本污染。', '2024-02-13T02:00:00Z'),
      src('https://b-daily.com/2', '论文揭示数据投毒风险', '该论文认为投毒成本很低。', '2024-02-13T04:00:00Z'),
      src('https://c-post.com/3', 'AI搜索为什么会被骗', '研究者发现注入少量文本即可。', '2024-02-14T02:00:00Z'),
      src('https://d-times.com/4', '数据投毒离我们有多远', '相关研究给出了警示。', '2024-02-14T03:00:00Z'),
    ],
  },

  // ---- 组 5：自媒体 --------------------------------------------------------
  {
    id: 'S13',
    name: '五篇微信公众号文章同一说法',
    why: '全部是自媒体，不构成独立来源',
    expect: { level: 'brief', grade: 'D' },
    sources: [
      src('https://mp.weixin.qq.com/s?a1', '震惊！这个行业已经占据全球七成', '该产业占全球73.6%份额。', '2026-10-28T02:00:00Z'),
      src('https://mp.weixin.qq.com/s?a2', '深度好文：七成份额背后', '份额达到73.6%。', '2026-10-28T04:00:00Z'),
      src('https://mp.weixin.qq.com/s?a3', '这个数字你知道意味着什么吗', '占全球73.6%。', '2026-10-29T02:00:00Z'),
      src('https://mp.weixin.qq.com/s?a4', '看完沉默了', '份额73.6%。', '2026-10-29T03:00:00Z'),
      src('https://mp.weixin.qq.com/s?a5', '转发让更多人看到', '份额73.6%。', '2026-10-30T02:00:00Z'),
    ],
  },
  {
    id: 'S14',
    name: '头条转载 + 光明网原文 + 人民网同题',
    why: '其中一条是转载，独立来源只有两家媒体',
    expect: { level: 'brief', grade: 'C' },
    sources: [
      src('https://m.gmw.cn/toutiao/2025-03/21/content_37919242.htm', '我国国民每晚平均睡6.85小时 你拖后腿了吗', '调查显示平均睡眠6.85小时。', '2025-03-21T02:00:00Z'),
      src('https://www.toutiao.com/article/7484176409724846632/', '我国国民每晚平均睡6.85小时 你拖后腿了吗', '调查显示平均睡眠6.85小时。', '2025-03-21T03:00:00Z'),
      src('https://www.people.com.cn/n1/2025/0321/x.html', '我国国民每晚平均睡6.85小时 你拖后腿了吗', '调查显示平均睡眠6.85小时。', '2025-03-21T04:00:00Z'),
    ],
  },
  {
    id: 'S15',
    name: '百家号 + 知乎 + 微博 + 头条',
    why: '跨平台不等于跨来源，全是自媒体',
    expect: { level: 'brief', grade: 'D' },
    sources: [
      src('https://baijiahao.baidu.com/s?id=1', '某产业占全球七成以上', '占全球73.6%。', '2026-10-28T02:00:00Z'),
      src('https://www.zhihu.com/question/1', '如何评价某产业占全球七成', '份额73.6%。', '2026-10-28T03:00:00Z'),
      src('https://weibo.com/1/abc', '某产业占全球七成', '份额73.6%。', '2026-10-28T04:00:00Z'),
      src('https://www.toutiao.com/article/2/', '七成份额是真的吗', '份额73.6%。', '2026-10-29T02:00:00Z'),
    ],
  },
  {
    id: 'S16',
    name: '【已知会失败】政府机关的公众号发布统计口径',
    why: '官方自媒体其实是权威生成方，但域名上与个人公众号无法区分',
    expect: { level: 'any', grade: 'B' },
    sources: [
      src('https://mp.weixin.qq.com/s?gov1', '国家统计局：三季度行业增速6.8%', '国家统计局发布数据，增速6.8%。', '2026-10-20T02:00:00Z'),
      src('https://mp.weixin.qq.com/s?gov2', '统计局公布三季度数据', '增速为6.8%。', '2026-10-20T03:00:00Z'),
      src('https://mp.weixin.qq.com/s?gov3', '三季度数据解读', '增速6.8%，与上季度持平。', '2026-10-20T04:00:00Z'),
    ],
  },

  // ---- 组 6：混合 ----------------------------------------------------------
  {
    id: 'S17',
    name: '一份政府公报 + 六篇公众号转述',
    why: '有锚，可信度成立；但需说明多数是自媒体',
    expect: { level: 'any', grade: 'B' },
    sources: [
      src('https://www.stats.gov.cn/sj/zxfb/2026.html', '2026年三季度行业运行情况', '国家统计局发布三季度数据。', '2026-10-20T02:00:00Z'),
      src('https://mp.weixin.qq.com/s?x1', '统计局：三季度增速6.8%', '据国家统计局，增速6.8%。', '2026-10-20T03:00:00Z'),
      src('https://mp.weixin.qq.com/s?x2', '三季度数据出炉', '增速6.8%。', '2026-10-20T04:00:00Z'),
      src('https://mp.weixin.qq.com/s?x3', '增速6.8%意味着什么', '增速6.8%。', '2026-10-20T05:00:00Z'),
      src('https://mp.weixin.qq.com/s?x4', '数据解读', '增速6.8%。', '2026-10-21T02:00:00Z'),
      src('https://mp.weixin.qq.com/s?x5', '转发：三季度数据', '增速6.8%。', '2026-10-21T03:00:00Z'),
      src('https://mp.weixin.qq.com/s?x6', '三季度数据一览', '增速6.8%。', '2026-10-21T04:00:00Z'),
    ],
  },
  {
    id: 'S18',
    name: '内容农场：八个域名，同一模板',
    why: '典型通稿矩阵，K=1',
    expect: { level: 'full', grade: 'D' },
    sources: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'].map((tag, i) => src(
      `https://${tag}-farm.com/p/${i}`,
      '有数据显示某产业占全球73.6%份额',
      '有数据显示，该产业已占全球73.6%的份额，稳居第一位。',
      '2026-10-28T09:00:00Z',
    )),
  },

  // ---- 组 7：边界 ----------------------------------------------------------
  {
    id: 'S19',
    name: '三家独立调查，数值接近但不相等（45% / 47% / 44%）',
    why: '真实独立测量，不是同一数字的变体',
    expect: { level: 'silent', grade: 'any' },
    sources: [
      src('https://a-news.com/1', '调查显示支持率为45%', '本次调查支持率45%。', '2026-05-01T02:00:00Z'),
      src('https://b-daily.com/2', '另一机构调查支持率47%', '另一项调查显示47%。', '2026-05-02T02:00:00Z'),
      src('https://c-post.com/3', '第三份调查支持率44%', '第三份调查结果为44%。', '2026-05-03T02:00:00Z'),
      src('https://d-times.com/4', '为什么三份调查数字不同', '抽样误差导致差异。', '2026-05-04T02:00:00Z'),
    ],
  },
  {
    id: 'S20',
    name: '只有 2 条结果',
    why: '样本太少，不该下任何判断',
    expect: { level: 'silent', grade: 'any' },
    sources: [
      src('https://a-news.com/1', '某产业占全球73.6%份额', '份额73.6%。', '2026-10-28T02:00:00Z'),
      src('https://b-daily.com/2', '某产业占全球73.6%份额', '份额73.6%。', '2026-10-28T03:00:00Z'),
    ],
  },
  {
    id: 'S21',
    name: '坏 URL / 缺字段',
    why: '输入脏数据不能崩，也不该乱判',
    expect: { level: 'silent', grade: 'any' },
    sources: [
      { url: 'not a url' },
      { url: '' },
      { url: 'https://x.com/1', title: 'a' },
    ],
  },
  {
    id: 'S22',
    name: '同一新闻各家加不同评论（标题不同、内文同源）',
    why: '各家评论不同，但事实部分同源，仍应折叠',
    expect: { level: 'full', grade: 'D' },
    sources: [
      src('https://a-news.com/1', '某产业七成份额，我们该高兴吗', '该产业占全球73.6%的份额，评论认为还需警惕。', '2026-10-28T02:00:00Z'),
      src('https://b-daily.com/2', '七成份额背后藏隐忧', '占全球73.6%的份额，隐忧在于结构。', '2026-10-28T04:00:00Z'),
      src('https://c-post.com/3', '这个七成，含金量有多高', '占全球73.6%的份额，含金量待考。', '2026-10-28T06:00:00Z'),
      src('https://d-times.com/4', '别急着庆祝七成份额', '占全球73.6%的份额，问题不少。', '2026-10-29T02:00:00Z'),
    ],
  },
]

let pass = 0
let fail = 0
const failures = []

console.log('\n================================ 场景矩阵 ================================\n')
console.log('编号  场景                                          期望           实际           '
  + '结果')
console.log('-'.repeat(104))

for (const item of cases) {
  let report
  let text = ''
  try {
    report = analyze(item.sources, item.options || {})
    text = render(report, item.options || {})
  } catch (error) {
    report = { level: 'THREW', grade: '-' }
    text = 'threw: ' + error.message
  }

  const levelOk = item.expect.level === 'any' || report.level === item.expect.level
  const gradeOk = item.expect.grade === 'any' || report.grade === item.expect.grade
  const good = levelOk && gradeOk && report.level !== 'THREW'

  const expectText = `${item.expect.level}/${item.expect.grade}`
  const actualText = `${report.level}/${report.grade === undefined ? '-' : report.grade}`
  const mark = good ? 'PASS' : 'FAIL'

  console.log(`${item.id}    ${pad(item.name, 44)}  ${pad(expectText, 13)}  ${pad(actualText, 12)}  ${mark}`)

  if (good) pass += 1
  else {
    fail += 1
    failures.push({ item, report, text, levelOk, gradeOk })
  }
}

function pad(text, width) {
  const value = String(text)
  let visible = 0
  for (const ch of value) visible += /[\u4e00-\u9fff]/.test(ch) ? 2 : 1
  const need = Math.max(0, width - visible)
  return value + ' '.repeat(need)
}

console.log('-'.repeat(104))
console.log(`总计 ${cases.length} 例：通过 ${pass}，不符 ${fail}\n`)

for (const entry of failures) {
  console.log(`\n---- ${entry.item.id} ${entry.item.name} ----`)
  console.log(`  逻辑预期：${entry.item.why}`)
  console.log(`  期望 ${entry.item.expect.level}/${entry.item.expect.grade}`
    + `，实际 ${entry.report.level}/${entry.report.grade === undefined ? '-' : entry.report.grade}`
    + `  [level ${entry.levelOk ? 'ok' : 'X'}, grade ${entry.gradeOk ? 'ok' : 'X'}]`)
  console.log('  插件实际输出：')
  console.log(entry.text.length > 0 ? entry.text.split('\n').map(line => '    ' + line).join('\n') : '    (silent)')
  console.log(`  指标：K=${entry.report.k} n=${entry.report.n} primary=${entry.report.hasPrimary}`
    + ` platformOnly=${entry.report.platformOnly} score=${entry.report.score}`)
}

if (fail > 0) process.exitCode = 1
console.log('')
