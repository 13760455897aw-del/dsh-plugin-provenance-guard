# 来源审计 · Provenance Guard

> **它不告诉你什么是真的，它告诉你这句话你能写多硬。**

一个跑在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里的检索审计插件。它在 `web_search` 的结果进入模型上下文**之前**，把 N 条结果折叠成 K 条相互独立的来源谱系，判断其中有没有生成方（机构/论文/公报），并把证据强度翻译成一句**你可以直接写进稿子的话**。

```
[来源审计] 主张「73.6%」｜K=1｜N=6｜无一手源｜D 级
· 出处：最早见于 a1-news.com（03-01 01:00），其后 5 条为同源转述
· 折叠：6 条 / 6 个站点 → 1 条独立谱系；最大谱系 6 条
· 锚点：未找到「73.6%」的生成机构或原始表（该数字见于 6 个站点）
· 可核查：https://a1-news.com/1
→ D 级：仅可「有说法称…（未获独立证实）」，不可写成「数据显示」
```

---

## 为什么需要它

大模型联网检索后写作时，默认把"检索到几条"当成"有几个证据"。这个假设在两类内容上系统性失效：

- **通稿与洗稿**：同一篇稿子被门户、聚合站、自媒体改标题后重复发布。检索层看到十几个域名，语义层只有一条信息。
- **内容农场**：批量生成的同模板文章围绕同一断言展开，措辞不同、结论一致。

后果不是"答错"，而是更隐蔽的一种：**语气与证据强度不匹配**——模型用"数据显示"的确定性，复述一个只在自媒体之间循环的数字。

---

## 它做什么

| 能力 | 输出 |
|---|---|
| **折叠** | `6 条结果 → 1 条独立谱系`，自媒体不计入独立来源 |
| **溯源** | 最早出现在哪个站点、什么时间、之后被几条转述 |
| **判级** | A/B/C/D，每级对应一个可执行的句式 |
| **核查** | 你说一个数字，它去抓原文，回答"这一页到底有没有这个数" |
| **台账** | 每次检索的等级/出处/转述数持久化，可回溯 |

### 四个等级 = 四种句式

| 等级 | 条件 | 你最多能写成 |
|---|---|---|
| **A** | 有生成方 + ≥2 条独立谱系 | 「数据显示…」（注明来源，可交叉印证） |
| **B** | 有生成方，但只有它一条 | 「据 XX 数据…」（注明机构） |
| **C** | 没有生成方 | 「据 X 报道…」（附链接，不可去来源化） |
| **D** | 数字自相矛盾 / 无独立谱系 / 单谱系被 ≥4 站复述 | 「有说法称…（未获独立证实）」，不给具体数值 |

> **C 是常态，不是差评。** A/B 要求结果里出现机构原始文件；中文检索的前几条里这很少见。C 的语义是"没有一手源，只能转述"。

### 什么时候出声

多数时候它**什么都不说**——每次都弹提示，模型会学会无视提示。

| 情形 | 输出 |
|---|---|
| 有生成方、无数字漂移 | 静默 |
| 生成方在集内但摘要没提这个数字 | 简条（附"权威页未及该数字"提醒） |
| 数字漂移 / 全部自媒体 / 单谱系被大量复述 | 全条 |

---

## 安装

需要 **DeepSeek Harness**（桌面版或 `dsh` CLI）。

### 从 npm 安装（推荐，国内可用）

```bash
dsh plugin --profile <你的 profile> add dsh-plugin-provenance-guard
```

走 npm 源（或 npmmirror 镜像），不需要能访问 GitHub。

### 从 Git 安装

```bash
dsh plugin --profile <你的 profile> add github:13760455897aw-del/dsh-plugin-provenance-guard
```

也可以直接给仓库地址：

```bash
dsh plugin --profile <你的 profile> add https://github.com/13760455897aw-del/dsh-plugin-provenance-guard.git
```

> 桌面版应用的 `desktop` profile 由客户端独占管理，用 CLI 装不进去——请在 **设置 → 插件** 里添加，或把插件装到另一个 profile 后用 `dsh --profile <名字>` 启动。

### 从插件市场安装

在「设置 → 插件 → 发现」里添加索引源（见下文「插件市场」），搜「来源审计」。

### 本地开发

```bash
git clone https://github.com/13760455897aw-del/dsh-plugin-provenance-guard
dsh plugin --profile <你的 profile> add /path/to/dsh-plugin-provenance-guard
```

装完**重启 Harness**（客户端 bundle 在启动时编排）。

---

## 用法

### 1. 自动审计

正常检索即可。结果集值得警告时，`web_search` 的返回开头会多出审计条；否则什么都不会发生。

### 2. 主动核查一个数字

直接对模型说：

> 这句话的数据靠谱吗：「2025 年新能源乘用车渗透率 53.9%」

模型会调用 `audit_claim`，跑一次指纹检索 + 一次原文抓取，返回：

```
【单点核查】2025年新能源乘用车渗透率53.9%
结论：B 级 —— 可断言，须注明生成性来源（机构/文件/论文）
· 依据：原文（cpcaauto.com）有这个数字，并给出了口径/方法
· 检索：「"53.9%" 新能源乘用车渗透率」→ 8 条 / 8 站点 / 2 条谱系
· 出处：最早见于 cbrand.com.cn（01-26 10:00），其后 3 条同源转述
· 页面：cpcaauto.com → 出现该数字，含口径/方法说明
· 可核查：https://…
· 建议：可以引用，但必须同时给出一手源链接；不要只写结论。
```

**判级由原文决定，不由结果集组成决定**：政府页面在结果里但没提这个数字，不会被算成一手源。

### 3. 查台账

会话标题栏右侧的「来源台账」按钮，列出本会话查过的每一次检索：等级、主张数字、最早出处、转述数。

---

## 插件市场（Discover）

插件市场按「索引源」工作：添加下面这个索引地址后，在「设置 → 插件 → 发现」里就能搜到本插件并一键安装。

| 网络 | 索引源地址 |
|---|---|
| 国内（推荐） | `https://gh-proxy.com/https://raw.githubusercontent.com/13760455897aw-del/dsh-plugin-provenance-guard/main/market/index.json` |
| 国内备用 | `https://ghproxy.net/https://raw.githubusercontent.com/13760455897aw-del/dsh-plugin-provenance-guard/main/market/index.json` |
| 可直连 GitHub | `https://raw.githubusercontent.com/13760455897aw-del/dsh-plugin-provenance-guard/main/market/index.json` |

索引文件在 [market/index.json](market/index.json)（格式 1），每个版本钉死在 Git 提交上，安装结果可复现。若 `ghproxy` 不可用，把前缀换成 `https://gh-proxy.com/` 亦可。

## 配置

可选文件：`$DSH_HOME/provenance-guard.json`（`DSH_HOME` 默认 `~/.dsh`）。修改后**下一次检索即生效**，不用重启。

```json
{
  "minSources": 3,
  "maxBlockChars": 900,
  "verify": true,
  "asyncVerify": true,
  "maxProbes": 3,
  "verifyTimeoutMs": 12000,
  "extraPrimaryHosts": []
}
```

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `minSources` | `3` | 少于该数不判定 |
| `maxBlockChars` | `900` | 审计条长度上限 |
| `extraPrimaryHosts` | `[]` | 追加的生成方域名 |
| `verify` / `asyncVerify` | `false` | 是否补证 / 是否后台补证 |
| `maxProbes` | `2` | 单会话补证上限 |
| `verifyTimeoutMs` | `12000` | 单次网络超时（毫秒） |

环境变量：`DSH_PROVENANCE_CONFIG`（配置文件路径）、`DSH_PROVENANCE_LEDGER`（台账路径）。

---

## 它不做什么

- ❌ 不判断真伪。真实的独家消息同样会被判 D——因为它没有第二个独立来源
- ❌ 不删除、不改写检索结果
- ❌ 默认不读正文：只看标题、摘要、时间、域名；只有补证和 `audit_claim` 会抓原文，各一篇
- ❌ 不跨会话共享记忆（台账按会话隔离）

**已知局限**：政府机关的微信公众号与个人营销号在域名上不可区分，会被判为自媒体；非百分比数字不做漂移检测；抓取受目标站点可用性影响。

---

## 开发

```bash
# 测试（零依赖，直接跑）
node test/audit.spec.mjs      # 审计引擎 59 项
node test/plugin.spec.mjs     # 接线与工具 65 项
node test/verify.spec.mjs     # 补证 30 项
node test/ui.spec.mjs         # 客户端 bundle 24 项
node test/scenarios.spec.mjs  # 22 个真实场景矩阵
```

结构：

```
index.js          # 宿主插件：post-execute、source_ledger、audit_claim、台账路由
lib/audit.js      # 审计引擎：折叠、权威分层、判级、渲染
lib/verify.js     # 补证：选页、抓取、页面判定
lib/client.js     # 浏览器 bundle：标题栏「来源台账」按钮 + 卡片
cordis.patch.yml  # bundle patch（默认配置）
```

设计说明见 [docs/TECHNICAL-REPORT.md](docs/TECHNICAL-REPORT.md)。

## License

MIT
