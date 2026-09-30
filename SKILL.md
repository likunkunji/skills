---
name: github-trending-cover
description: 抓取 GitHub Trending 日榜与周榜，规范化仓库数据并补一行中文简介，最终汇总渲染成一张封面图，同时产出 Markdown 报告与原始 JSON。当用户要求"GitHub 日榜/周榜/热榜""GitHub trending 榜单""生成 GitHub 榜单封面图/日报配图""开源热榜一张图""GitHub trending cover/digest"时触发。
---

# GitHub Trending 榜单封面

把 GitHub Trending 的日榜与周榜汇总成一张可直接分享的封面图。链路是确定性的：
Node 脚本抓取解析 → 模型补中文简介 → 无头 Chromium 渲染 PNG → 程序化校验版式。
脚本零 npm 依赖，只用本机 Node 与 Chrome/Edge。

## 环境要求

- Node.js 18+（用到内置 `fetch`），无需 `npm install`。
- 本机 Chrome 或 Edge；自动探测，也可用 `--browser "<可执行文件路径>"` 或 `CHROME_PATH` 指定。
- 中文渲染依赖系统 CJK 字体（Windows 微软雅黑 / macOS 苹方 / Linux Noto Sans CJK）。
  缺字体时封面中文会变方框，先装字体再重跑。
- `anime` 主题的手写感依赖圆润/展示体：标题优先华文琥珀，正文优先幼圆，拉丁字符走 Comic Sans MS，
  缺失时自动回退微软雅黑/苹方（观感会变"正规"，但不会出错）。`manga` 标题优先方正姚体。

## 工作流

1. 与用户确认参数：榜单（默认 `daily,weekly`）、条数（默认 10）、语言或话题过滤（默认全语言）、
   视觉主题（默认 `anime` 动漫手绘风；另有 `manga` 黑白网点、`dashboard` 深色数据面板）、
   封面尺寸（默认 1600×900 横版双栏）、输出目录（默认 workspace 下 `github-trending/<YYYY-MM-DD>/`）。
   用户没说就按默认值直接跑，不要反复追问。
2. 抓取数据。产出 `data.json`，stdout 会打印每个榜的条数与前三名。
3. 读 `data.json`，为**每条**仓库写一行中文简介，写入同目录 `summaries.json`
   （`{"owner/repo": "中文一句话"}`）。写作规则见 `references/cover-design.md` 的"中文简介"小节。
4. 渲染封面 `cover.png`，同目录会留下填充好的 `cover.png.html` 供微调与校验。
   默认 `--theme anime`（奶油纸底 + 墨线描边 + 赛璐璐硬阴影 + 贴纸徽章 + 圆体手写字 + 吉祥物），
   刻意避开"产品后台截图"式的真实感；要写实数据面板就显式传 `--theme dashboard`。
5. **必须**跑版式校验。模型看不到图片像素，只有这个校验能证明没有裁切；
   `FAIL` 按提示缩小 `--limit`、加大 `--height` 或缩短简介后重跑第 4 步。
6. 生成 Markdown 报告 `report.md`。
7. 用 `Image` 工具展示 `cover.png`，并汇报四件产物的绝对路径、数据来源与抓取时刻。

## 命令

脚本随 skill 安装，用 `cwd` 指到 scripts 目录后按相对名调用；`--out` 一律传**绝对路径**，
否则产物会写进 skill 目录。

```bash
# 2. 抓取日榜 + 周榜
Bash(cwd="skill://github-trending-cover/scripts",
     command="node fetch-trending.mjs --out \"<ABS_WS>/github-trending/<DATE>/data.json\" --since daily,weekly --limit 10")

# 4. 渲染封面（默认 anime 主题，1600x900 双栏，2x 输出 3200x1800）
Bash(cwd="skill://github-trending-cover/scripts",
     command="node render-cover.mjs --data \"<ABS_WS>/.../data.json\" --summaries \"<ABS_WS>/.../summaries.json\" --out \"<ABS_WS>/.../cover.png\" --theme anime")

# 5. 版式校验（尺寸必须与渲染参数一致）
Bash(cwd="skill://github-trending-cover/scripts",
     command="node check-layout.mjs --html \"<ABS_WS>/.../cover.png.html\" --width 1600 --height 900 --scale 2")

# 6. Markdown 报告
Bash(cwd="skill://github-trending-cover/scripts",
     command="node write-report.mjs --data \"<ABS_WS>/.../data.json\" --summaries \"<ABS_WS>/.../summaries.json\" --out \"<ABS_WS>/.../report.md\"")
```

四个脚本都支持 `--help`。常用可选参数：`--theme anime|manga|dashboard`、`--language python`、
`--topic ai-agent`、`--spoken zh`、`--source api`、`--width/--height/--scale/--columns/--layout/--limit`、
`--title/--subtitle/--date/--footer-left`。

## 规则

- 不要臆造数据。抓取失败时报告 `board.error`，说明是否已降级为 Search API 近似数据
  （`approximate: true`），绝不编造 star 数或排名。
- 中文简介只能依据页面 `description` 与仓库名概括；页面无描述就写"（页面无描述）"，不要猜功能。
- 不要跳过第 5 步校验，也不要因为"图片已生成"就宣称版式正常。
- 不要把 `GITHUB_TOKEN` 写进文件、脚本或聊天内容；只允许以环境变量方式提供给 Search API 降级路径。
- 产物写在 workspace 内；用户要求写到别处时，先确认目标路径再执行。
- 本机 Bash 实际可能跑在 PowerShell 上（无 Git Bash 时）：命令里不要用 `&&`、`export`、
  `cat/ls/grep` 等 bash 语法，也不要以 `&` 开头调用程序（会被后台命令检查拦截）。
  读文件用 Read/Grep/Glob，删文件用 Delete，不要用 shell 命令替代。
- 改视觉风格（配色、描边、阴影、字体、装饰）只改 `assets/themes/<theme>.css` 与同名的
  `<theme>.bg.html` / `<theme>.head.html`；改结构或布局才改 `assets/cover-template.html`
  （占位符清单见 `references/cover-design.md`）。不要把 CSS 硬写进脚本。
- 主题 CSS 里**严禁**覆盖 `.row` 的 `flex` / `max-height` / `container-type` 与 `.list` 的
  `overflow`，那是行高自适应与防裁切机制的所在；改了会让 `check-layout.mjs` 报 FAIL。

## 参考文件

- `references/data-source.md`：数据源与字段含义、HTML 解析结构、降级策略、网络与结构变更排错。
- `references/cover-design.md`：版式令牌与占位符、尺寸变体配方、中文简介写作规范、配色与微调方法。
