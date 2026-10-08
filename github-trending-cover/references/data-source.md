# 数据源与解析

`scripts/fetch-trending.mjs` 的取数细节、字段语义与排错。改解析器前先读这份。

## 数据源选择

| 源 | 地址 | 优点 | 缺点 |
|---|---|---|---|
| Trending HTML（默认） | `https://github.com/trending[/<language>]?since=daily\|weekly\|monthly` | 唯一提供 `stars today` / `stars this week` 增量；排序即官方热榜 | 非官方接口，无契约，HTML 结构可能变；无 topic 过滤 |
| Search API（降级 / `--topic`） | `https://api.github.com/search/repositories` | 官方、稳定、支持 `topic:`、返回完整元数据 | 拿不到"期间新增 star"，只能用 `created:>DATE` + `sort=stars` 近似 |

默认 `--source auto`：先抓 Trending HTML，失败或解析到 0 条时自动降级到 Search API，
并把该 board 标记 `approximate: true` + 写明 `note`。`--source trending` 禁止降级，
`--source api` 强制走 API。传了 `--topic` 一定走 API（Trending 页面不支持话题过滤）。

## Trending URL 形态

```text
https://github.com/trending?since=daily                       # 全语言日榜
https://github.com/trending?since=weekly                      # 全语言周榜
https://github.com/trending/python?since=daily                # 指定语言
https://github.com/trending/python?since=daily&spoken_language_code=zh
```

`--language` 用 GitHub 的语言 slug（小写，如 `python`、`typescript`、`c++` 会被 URL 编码）。
`--spoken` 对应 `spoken_language_code`。多个 `--since` 值按顺序**串行**抓取，避免并发触发风控。

## HTML 结构与字段映射

每个仓库是一个 `<article class="Box-row">…</article>`。解析器按块切片后在块内取字段：

| 字段 | 定位方式 | 说明 |
|---|---|---|
| `full_name` / `owner` / `name` | `<h2 …>` 内第一个 `<a href="/owner/repo">` | 去掉查询串与首尾斜杠 |
| `description` | `<p class="…col-9…">…</p>` | 可能缺失；去标签 + 解实体 + 压空白 |
| `language` | `<span itemprop="programmingLanguage">` | 可能缺失 |
| `language_color` | `.repo-language-color` 的 `background-color` | 用于封面上的语言圆点 |
| `stars` | `href="…/stargazers"` 锚文本里的数字 | **仓库总 star**，不是增量 |
| `forks` | `href="…/forks"`（旧版为 `/network/members`） | |
| `period_stars` | 文本 `<n> stars today\|this week\|this month` | **期间新增**，封面右侧高亮徽章 |
| `built_by` | 头像 `alt="@user"` | 贡献者列表 |

数字带千分位逗号，统一走 `toInt()` 去逗号转数字。文本一律 `decodeEntities()` 解
`&amp; &lt; &gt; &quot; &#39; &#NNN; &#xHH;`。

## 输出 JSON 结构

```jsonc
{
  "generated_at": "2026-09-30T03:36:31.943Z",
  "filters": { "language": null, "topic": null, "spoken_language_code": null },
  "limit": 10,
  "boards": [
    {
      "since": "daily",
      "label": "日榜",
      "period_label": "今日新增",
      "source": "github-trending-html",   // 或 github-search-api
      "url": "https://github.com/trending?since=daily",
      "fetched_at": "…",
      "approximate": false,
      "note": null,
      "error": null,
      "items": [
        {
          "rank": 1,
          "full_name": "owner/repo",
          "owner": "owner", "name": "repo",
          "url": "https://github.com/owner/repo",
          "description": "…", "language": "Python", "language_color": "#3572A5",
          "stars": 48481, "forks": 5428,
          "period_stars": 4758, "period_label_en": "today",
          "built_by": ["user1", "user2"],
          "zh": null                       // 由 summaries.json 合并填充
        }
      ]
    }
  ]
}
```

`period_stars` 在 Search API 路径下为 `null`（API 不提供增量），封面会渲染成 `—` 徽章。

## 降级路径语义

Search API 近似口径：

```text
daily   -> q=created:>(today-2d)  sort=stars desc
weekly  -> q=created:>(today-7d)  sort=stars desc
monthly -> q=created:>(today-30d) sort=stars desc
```

含义是"近 N 天新建仓库里 star 最多的"，与 Trending 的"期间新增 star 最多"**不是同一个口径**，
所以必须保留 `approximate: true` 与 `note`，在报告和汇报里明确说明是近似数据。
`per_page` 取 `limit*2`（上限 100）再截断，留出过滤余量。

## 速率限制与鉴权

- Trending HTML：无官方限额，但高频抓取会被风控；脚本默认失败重试 2 次（700ms 递增退避），
  多 board 串行抓取。
- Search API：未鉴权 10 次/分钟、60 次/小时；设置环境变量 `GITHUB_TOKEN` 可提到 30 次/分钟。
  Token 只从环境变量读取，**不要**写进脚本、JSON 或聊天内容。
- 请求固定带浏览器 UA（`Mozilla/5.0 …Chrome/126`），空 UA 会被拒。

## 排错

| 现象 | 原因与处置 |
|---|---|
| `HTTP 403/429` | 触发风控或限额。等几分钟重试；API 路径设 `GITHUB_TOKEN`；降低抓取频率 |
| `items=0` 且 `error: …no <article class="Box-row"> rows were parsed` | GitHub 改版了。见下节"结构变更" |
| 超时 / `fetch failed` | 公司代理或 DNS。设 `HTTPS_PROXY` 后重试，或改用 `--source api`；必要时用 Browser 工具人工打开 trending 页面确认是否可访问 |
| 所有 board 都为空 | 脚本退出码 2。先确认网络，再试 `--source api`（配 `GITHUB_TOKEN`） |
| 条数比预期少（如 14/18 条而非 25） | 匿名访问时页面返回条数会浮动，属正常；`--limit` 大于实际条数时按实际条数渲染 |
| 某些仓库无 `description` | 页面本身就没写。中文简介按"（页面无描述）"处理，不要编造 |

### 结构变更怎么修

1. 手动抓一份页面存盘，确认新的块级标签：搜索 `Box-row`、`programmingLanguage`、`stars today`。
2. 改 `parseTrendingHtml()` 里对应的正则；它已 `export`，可单独用
   `node -e "import('.../fetch-trending.mjs').then(m=>console.log(m.parseTrendingHtml(html,3)))"` 验证。
3. 保持输出字段名不变，下游 `render-cover.mjs` / `write-report.mjs` 就不用改。
4. 修完跑一次完整链路，并用 `check-layout.mjs` 确认封面没被撑破。
