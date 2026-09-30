# 封面版式与中文简介

`assets/cover-template.html` + `scripts/render-cover.mjs` + `scripts/check-layout.mjs` 的设计约定。

## 画布与栅格

默认 1600×900 CSS 像素，`--scale 2` 输出 3200×1800 PNG（够清晰，文件约 1.6MB）。

```text
body  = flex column，padding 34px 40px（随 uiScale 缩放）
├ header  品牌标记 + 标题 + 副标题  |  右侧日期 + 过滤/来源信息
├ .cols   grid，列数 = COL_COUNT（board 数，上限 3），gap 18px
│  └ .col 面板：顶部 3px 强调色条 + .col-head（chip 徽标 + 说明）+ .list
│     └ .list  flex column，overflow hidden
│        └ .row  flex:1 1 0 + max-height:var(--row-h) + container-type:size
│           ├ .rank  前三名分别用金/银/铜色
│           └ .main  .l1（owner/ + repo + 语言点 + 总 star + 期间增量徽章）
│                    .l2（一行中文简介，nowrap + ellipsis）
└ footer  数据来源说明  |  生成时间
```

**行高由浏览器 flex 真实分配**，脚本给的 `--row-h` 只是 `max-height` 上限（用于条目少时
不把行撑得过高）。这样估算误差不会造成裁切。`.row` 带 `container-type:size`，
行高低于 `COMPACT_BELOW` 时用容器查询自动隐藏 `.l2`；`body.compact` 是不支持容器查询时的兜底。

`uiScale = clamp(0.72, min(width/refWidth, height/900), 1.6)`，其中单栏 `refWidth=820`、
多栏 `refWidth=1600`。所有字号与内边距按 `uiScale` 缩放，所以换尺寸不用改 CSS。

## 主题系统

模板被拆成"骨架 + 主题"两层，换风格不动布局：

- `assets/cover-template.html` 只放**布局骨架**：body flex、`.cols` grid、`.list`/`.row` 的
  flex 行高自适应、`container-type:size` 容器查询、`overflow`/`ellipsis` 防裁切规则，以及全部
  占位符。这些规则任何主题都不得覆盖。
- `assets/themes/<theme>.css` 只放**视觉**：配色令牌、背景、描边、圆角、阴影、字体、字距，
  以及 `.chip` / `.dl` / `.rank` 等部件的装饰性外观。
- `assets/themes/<theme>.bg.html`（可选）注入 `.decor` 背景装饰层：绝对定位、
  `pointer-events:none`、`z-index:0`，内容层 `z-index:1`，因此**不参与布局、不会挤走行高**。
- `assets/themes/<theme>.head.html`（可选）注入 `.head-mid`，是 header 里的一个正常 flex 子项
  （anime 主题用它放吉祥物），header 会因它变高，行高仍由 flex 自动重分配。

| 主题 | 观感 | 关键手法 |
|---|---|---|
| `anime`（默认） | 手账/动画分镜里撕下来的一页，**刻意不像产品截图** | 奶油纸底 + 3px 墨线描边 + 赛璐璐硬阴影（`6px 6px 0 ink`）+ 贴纸徽章微旋转 + 半调网点 + 手绘涂鸦/星星 + 吉祥物 + 华文琥珀标题/幼圆正文/Comic Sans 拉丁 |
| `manga` | 漫画单行本内页 | 新闻纸底 + 黑白为主 + 单一朱红强调（日榜红、周榜墨）+ 角落速度线（`repeating-conic-gradient` + `mask-image` 渐隐）+ 双线分栏框 + 网点 |
| `dashboard` | 真实 GitHub Dark 数据面板（最"写实"） | 深色渐变光晕 + 半透明面板 + 1px 细边框 + 弥散阴影 + 微软雅黑 |

**每主题的非行高纵向成本**（`render-cover.mjs` 里的 `THEME_OVERHEAD`，1600×900 双栏实测校准）：
`dashboard 268` / `manga 279` / `anime 314`。它只用于预判 compact 模式，真实行高由 flex 决定；
新增主题后请用 `check-layout.mjs` 输出的 `list=xxx/xxx` 反算 `900 - listClientH` 并回填该值。

新增主题：复制一份 `<name>.css`（必要时加 `.bg.html` / `.head.html`），保持类名不变，
渲染时 `--theme <name>` 即可；主题名不在库里时脚本会报错并列出可用主题。

## 模板占位符

改模板时这些必须保留（渲染器发现未替换的 `{{大写_占位符}}` 会直接报错）：

| 占位符 | 含义 |
|---|---|
| `WIDTH` / `HEIGHT` | CSS 画布尺寸 |
| `ROW_H` | 行高上限（max-height） |
| `COMPACT_BELOW` | 行高低于此值则隐藏中文简介行 |
| `PAD_X` / `PAD_Y` | body 内边距 |
| `COL_COUNT` | grid 列数 |
| `BODY_CLASS` | `theme-<name>`，需要时再追加 `compact` |
| `TITLE` / `SUBTITLE` | 标题 / 副标题 |
| `DATE_LINE` / `META_LINE` | 右上日期 / 过滤条件与数据来源 |
| `FOOTER_LEFT` / `FOOTER_RIGHT` | 页脚左（来源声明）/ 右（生成时间） |
| `COLUMNS` | 渲染器拼好的 `<section class="col">…` 列表 |
| `THEME_NAME` | 主题名，仅用于样式注释 |
| `THEME_CSS` | `assets/themes/<theme>.css` 的完整内容 |
| `DECOR_BG` | 背景装饰层（无片段时为空的 `.decor` 容器） |
| `DECOR_HEAD` | header 内的装饰 flex 子项（无片段时为空串） |
| `*_FS` | 字号：`TITLE_FS SUB_FS DATE_FS META_FS COLT_FS COLN_FS RANK_FS NAME_FS TAG_FS ST_FS DL_FS DESC_FS FOOT_FS` |

配色令牌在 `:root`：`--bg --panel --border --text --muted --muted-2`，
强调色 `--daily:#f78166`、`--weekly:#58a6ff`、`--monthly:#d2a8ff`，
名次色 `--gold --silver --bronze`。第 4 个及以后的 board 会循环复用强调色。
`.chip` / `.dl` 里 `color-mix()` 前面都留了 rgba 兜底声明，老版 Chromium 不会掉样式。

## 尺寸变体配方

```bash
# A. 横版双栏（默认）：日榜 + 周榜各 Top 10
render-cover.mjs --data data.json --summaries summaries.json --out cover.png
#    → 1600x900，scale 2 → 3200x1800

# B. 手机竖版：日榜、周榜上下堆叠，条目更多
fetch-trending.mjs --out data.json --since daily,weekly --limit 14
render-cover.mjs --data data.json --summaries summaries.json --out cover.png \
  --width 1080 --height 1920 --limit 14
#    → height > width，--layout auto 自动选 stack（上下堆叠），两榜都渲染；
#      想强制并排就加 --layout columns，想强制堆叠就加 --layout stack

# C. 社交分享卡片：信息密度低、标题醒目
fetch-trending.mjs --out data.json --since daily,weekly --limit 5
render-cover.mjs --data data.json --summaries summaries.json --out cover.png \
  --width 1200 --height 630 --limit 5 --scale 2

# D. 只要文件小：降 scale
render-cover.mjs … --scale 1
```

`--columns` 大于数据里的 board 数时按 board 数渲染；小于时多余的 board 会被丢弃并在
stdout 打 warn。想自定义文案用 `--title/--subtitle/--date/--meta/--footer-left/--footer-right`。

## 中文简介（summaries.json）

第 3 步由模型生成，是封面可读性的关键。格式二选一：

```json
{ "owner/repo": "中文一句话简介" }
```
```json
[{ "full_name": "owner/repo", "zh": "中文一句话简介" }]
```

写作规范：

- **长度**：单栏 ≤ 38 个汉字，双栏 1600×900 建议 ≤ 34 个汉字。超长会被省略号截断，
  `check-layout.mjs` 会以 `warn: N Chinese summary line(s) ellipsised` 报出来。
- **只依据页面信息**：`description` + 仓库名 + 语言。不要凭仓库名猜功能，不要加
  "最强/第一/爆款"这类评价，不要写 star 数（右侧已有徽章）。
- **无描述时**：写 `（页面无描述）`，或按仓库名做保守概括并显式标注，例如
  `"Anthropic 面向金融服务场景的官方仓库（页面无描述）"`。
- **术语保留英文**：MCP、CLI、Agent、LLM、RAG、Docker、React 等不翻译；产品名保持原样。
- **风格**：陈述句、不用句号结尾、不用引号包裹；标点用中文全角，数字与单位用半角。
- **覆盖全部条目**：日榜和周榜常出现同一仓库，同一个 `full_name` 只需写一条，两栏会共用。
- 缺简介时渲染器会 warn 并回退英文 `description`；能补就补，别放着不管。

## 校验结果怎么读

`check-layout.mjs` 用 `--dump-dom` 注入探针脚本量真实布局。注意 `--dump-dom` 的视口比
`--screenshot` 小（窗口装饰 + 预留滚动条，本机实测偏移 22×98），所以脚本会**先量偏移再按
校正后的 window-size 重测**，输出里的 `note: viewport calibrated …` 是正常信息。

| 输出 | 含义 | 处置 |
|---|---|---|
| `PASS` | 无裁切、无溢出、无截断 | 直接展示 |
| `clippedRows > 0` / `listScrollH > listClientH` | 行掉出列表框 | 减 `--limit` 或加 `--height` |
| `contentClippedRows > 0` | 行内文字比行高还高 | 同上；或缩短中文简介 |
| `Page overflows vertically/horizontally` | 整页溢出 | 检查是否手改了模板 padding/字号 |
| `warn: … ellipsised` | 文案被省略号截断 | 缩短简介；仓库名截断通常可接受 |
| `desc=0/N` | 该栏简介行全被隐藏（compact） | 想让简介显示就减 `--limit` 或加 `--height` |
| `note: could not calibrate viewport …` | 校正失败 | 结果仍可参考行级指标；页级溢出判定已跳过 |

退出码：`0` = PASS/WARN，`3` = FAIL，`1` = 检查本身没跑起来（找不到浏览器、HTML 不存在等）。
FAIL 时**必须**修完重渲染再展示，不能只凭 PNG 已生成就宣称版式正常。

## 常见问题

- **中文变方框**：系统缺 CJK 字体。装微软雅黑/苹方/Noto Sans CJK，或在模板 `body` 的
  `font-family` 里前置一个已安装字体名。
- **PNG 太大**：`--scale 1`，或把 `--width/--height` 调小。
- **浏览器启动超时 `ETIMEDOUT`**：`scripts/browser.mjs` 已为每次启动创建独立
  `--user-data-dir` 临时配置目录并重试一次（避免和用户已打开的 Chrome 抢配置锁）。
  仍失败就关掉其他 Chrome 窗口、加大 `--timeout`，或用 `--browser` 指定 Edge。
- **想换配色/字体/圆角/描边**：只改 `assets/themes/<theme>.css`，不要改脚本，也不要在骨架模板里
  写死视觉样式；改完重跑渲染 + 校验。
- **anime 主题看起来不够"手绘"**：多半是系统缺幼圆/华文琥珀，回退到了微软雅黑。
  装字体，或在 `anime.css` 的 `font-family` 链里前置一个本机已有的圆润字体名。
- **想整体换成写实数据面板**：`--theme dashboard`（原始深色 GitHub 风）。
- **想看填充后的 HTML**：默认保留在 `<out>.html`，可直接用浏览器打开肉眼核对。
