#!/usr/bin/env node
/**
 * Render the GitHub trending cover image from normalized board JSON.
 *
 * Pipeline: data.json (+ optional summaries.json) -> filled HTML template -> PNG
 * via a locally installed headless Chromium browser (Chrome or Edge). No npm
 * dependencies are required.
 *
 * Usage:
 *   node render-cover.mjs --data data.json --out cover.png
 *   node render-cover.mjs --data data.json --summaries summaries.json --out cover.png
 *   node render-cover.mjs --data data.json --out cover.png --width 1080 --height 1920 --layout stack
 *
 * Options:
 *   --data        <path>  Required. JSON produced by fetch-trending.mjs.
 *   --out         <path>  Required. PNG output path (parent dirs are created).
 *   --summaries   <path>  Optional. Agent-written Chinese one-liners. Either an
 *                         object {"owner/repo": "中文简介"} or an array of
 *                         {full_name, zh}. Values are merged into item.zh.
 *   --template    <path>  Default: ../assets/cover-template.html next to this script.
 *   --theme       <name>  Visual theme: anime (default) | manga | dashboard.
 *                         anime  = cream paper, ink outlines, cel-shaded hard shadows,
 *                                  sticker badges, rounded hand-drawn CJK fonts, mascot.
 *                         manga  = newsprint black & white, halftone dots, speed lines,
 *                                  one red accent.
 *                         dashboard = the original dark GitHub-like data panel
 *                                  (most "product screenshot" of the three).
 *                         Each theme is assets/themes/<name>.css plus optional
 *                         <name>.bg.html / <name>.head.html decoration snippets.
 *   --width       <px>    Default 1600.
 *   --height      <px>    Default 900.
 *   --scale       <n>     Device scale factor. Default 2 (=> 3200x1800 PNG at 1600x900).
 *   --columns     <n|auto> Board columns for the side-by-side layout. auto = number of
 *                         boards in the data (capped at 3).
 *   --layout      <mode>  auto (default) | columns | stack. auto picks stack when the
 *                         canvas is taller than wide, so 1080x1920 puts the boards
 *                         one above the other instead of side by side.
 *   --limit       <n>     Rows per column. Default: the board's own item count (max 12).
 *   --title       <text>  Default "GitHub Trending".
 *   --subtitle    <text>  Default derived from the boards, e.g. "开源热榜 · 日榜 / 周榜".
 *   --date        <text>  Default: today's local date.
 *   --meta        <text>  Default: source + filters summary.
 *   --footer-left <text>  Default: data source attribution.
 *   --footer-right <text> Default: generation timestamp.
 *   --browser     <mode>  auto (default) | chrome | edge | <absolute path to executable>.
 *   --row-h       <px>    Override the auto-fitted row height.
 *   --html-out    <path>  Where the filled HTML is written. Default "<out>.html".
 *   --no-html             Do not keep the filled HTML file.
 *   --timeout     <ms>    Browser timeout. Default 60000.
 *   --quiet               Only print the PNG path on success.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, runBrowser } from './browser.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const ACCENTS = ['--daily', '--weekly', '--monthly'];
const BOARD_EN = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

// Base sizes, tuned for a 1600x900 canvas (uiScale = 1).
const BASE_FS = {
  TITLE: 30, SUB: 13.5, DATE: 15, META: 11.5,
  COLT: 15, COLN: 11.5, RANK: 13, NAME: 15.5,
  TAG: 11.5, ST: 12.5, DL: 12.5, DESC: 12.5, FOOT: 11.5,
};

// Non-row vertical cost per theme (body padding + header + footer + column
// chrome), measured on a 1600x900 two-column canvas at uiScale 1. Only used to
// pre-decide compact mode; real row heights come from flex distribution.
const THEME_OVERHEAD = { dashboard: 268, manga: 279, anime: 314 };
const DEFAULT_OVERHEAD = 280;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {
    data: null, out: null, summaries: null, template: null, theme: 'anime',
    width: 1600, height: 900, scale: 2, columns: 'auto', layout: 'auto', limit: null,
    title: 'GitHub Trending', subtitle: null, date: null, meta: null,
    footerLeft: null, footerRight: null, browser: 'auto', rowH: null,
    htmlOut: null, keepHtml: true, timeout: 60000, quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--data': o.data = next(); break;
      case '--out': o.out = next(); break;
      case '--summaries': o.summaries = next(); break;
      case '--template': o.template = next(); break;
      case '--theme': o.theme = next(); break;
      case '--width': o.width = Number(next()); break;
      case '--height': o.height = Number(next()); break;
      case '--scale': o.scale = Number(next()); break;
      case '--columns': o.columns = next(); break;
      case '--layout': o.layout = next(); break;
      case '--limit': o.limit = Number(next()); break;
      case '--title': o.title = next(); break;
      case '--subtitle': o.subtitle = next(); break;
      case '--date': o.date = next(); break;
      case '--meta': o.meta = next(); break;
      case '--footer-left': o.footerLeft = next(); break;
      case '--footer-right': o.footerRight = next(); break;
      case '--browser': o.browser = next(); break;
      case '--row-h': o.rowH = Number(next()); break;
      case '--html-out': o.htmlOut = next(); break;
      case '--no-html': o.keepHtml = false; break;
      case '--timeout': o.timeout = Number(next()); break;
      case '--quiet': o.quiet = true; break;
      case '-h':
      case '--help': o.help = true; break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (o.help) return o;
  if (!o.data) throw new Error('--data <path> is required');
  if (!o.out) throw new Error('--out <path> is required');
  for (const k of ['width', 'height', 'scale', 'timeout']) {
    if (!Number.isFinite(o[k]) || o[k] <= 0) throw new Error(`--${k} must be a positive number`);
  }
  if (o.columns !== 'auto') {
    const n = Number(o.columns);
    if (!Number.isInteger(n) || n < 1 || n > 3) throw new Error('--columns must be auto or 1..3');
    o.columns = n;
  }
  if (!['auto', 'columns', 'stack'].includes(o.layout)) {
    throw new Error(`--layout must be auto, columns or stack (got "${o.layout}")`);
  }
  return o;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const clamp = (lo, v, hi) => Math.min(hi, Math.max(lo, v));

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function num(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return null;
  return Number(n).toLocaleString('en-US');
}

function shortNum(n) {
  if (n === null || n === undefined) return null;
  const v = Number(n);
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(v);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readSummaries(path) {
  const raw = loadJson(path);
  const map = new Map();
  if (Array.isArray(raw)) {
    for (const e of raw) {
      const key = e.full_name || e.repo || e.name;
      const val = e.zh || e.summary || e.text;
      if (key && val) map.set(String(key).toLowerCase(), String(val));
    }
  } else if (raw && typeof raw === 'object') {
    const entries = raw.summaries && typeof raw.summaries === 'object' ? raw.summaries : raw;
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v === 'string' && v.trim()) map.set(k.toLowerCase(), v.trim());
      else if (v && typeof v === 'object' && (v.zh || v.summary)) map.set(k.toLowerCase(), String(v.zh || v.summary));
    }
  }
  return map;
}

function pngSize(path) {
  try {
    const fd = readFileSync(path);
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!fd.subarray(0, 8).equals(sig)) return null;
    return { width: fd.readUInt32BE(16), height: fd.readUInt32BE(20) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTML assembly
// ---------------------------------------------------------------------------

function rowHtml(item, accentVar, uiScale) {
  const rankCls = item.rank <= 3 ? ` top${item.rank}` : '';
  const lang = item.language
    ? `<span class="tag"><i class="ldot" style="background:${esc(item.language_color || '#8b949e')}"></i>${esc(item.language)}</span>`
    : '';
  const stars = num(item.stars) !== null ? `<span class="st">${esc(shortNum(item.stars))}</span>` : '';
  const delta = item.period_stars !== null && item.period_stars !== undefined
    ? `<span class="dl">+${esc(shortNum(item.period_stars))}</span>`
    : `<span class="dl na">—</span>`;
  const summary = (item.zh && String(item.zh).trim()) || item.description || '';
  return [
    `      <li class="row${rankCls}">`,
    `        <span class="rank">${item.rank}</span>`,
    `        <div class="main">`,
    `          <div class="l1">`,
    `            <span class="name"><span class="owner">${esc(item.owner)}/</span>${esc(item.name)}</span>`,
    `            ${lang}${stars}${delta}`,
    `          </div>`,
    summary ? `          <div class="l2">${esc(summary)}</div>` : '',
    `        </div>`,
    `      </li>`,
  ].filter(Boolean).join('\n');
}

function columnHtml(board, index, limit, uiScale) {
  const accent = `var(${ACCENTS[index % ACCENTS.length]})`;
  const items = board.items.slice(0, limit);
  const en = BOARD_EN[board.since] || board.since;
  const note = board.approximate
    ? '近似数据（Search API）'
    : `${board.period_label || '新增 star'} · Top ${items.length}`;
  return [
    `  <section class="col" style="--accent:${accent}">`,
    `    <div class="col-head">`,
    `      <span class="chip">${esc(board.label || en)} · ${esc(en)}</span>`,
    `      <span class="col-note">${esc(note)}</span>`,
    `    </div>`,
    `    <ol class="list">`,
    items.length
      ? items.map((it) => rowHtml(it, accent, uiScale)).join('\n')
      : '      <li class="row"><span class="rank">-</span><div class="main"><div class="l1"><span class="name">本次未取到数据</span></div></div></li>',
    `    </ol>`,
    `  </section>`,
  ].join('\n');
}

function fillTemplate(tpl, vars) {
  let out = tpl;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(String(v));
  }
  const left = out.match(/\{\{[A-Z_]+\}\}/g);
  if (left) throw new Error(`Template placeholders not filled: ${[...new Set(left)].join(', ')}`);
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    process.stdout.write('Usage: node render-cover.mjs --data data.json --out cover.png [--summaries s.json]\n' +
      '  [--theme anime|manga|dashboard] [--template t.html] [--width 1600] [--height 900]\n' +
      '  [--scale 2] [--columns auto|1..3]\n' +
      '  [--layout auto|columns|stack]\n' +
      '  [--limit n] [--title T] [--subtitle S] [--date D] [--meta M] [--footer-left L]\n' +
      '  [--footer-right R] [--browser auto|chrome|edge|<path>] [--row-h px] [--html-out p]\n' +
      '  [--no-html] [--timeout ms] [--quiet]\n');
    return;
  }

  const data = loadJson(resolve(o.data));
  const boards = Array.isArray(data.boards) ? data.boards : [];
  if (boards.length === 0) throw new Error('data.json contains no boards; re-run fetch-trending.mjs');

  const warnings = [];

  // --- merge Chinese summaries ---
  let sumMap = new Map();
  if (o.summaries) {
    const p = resolve(o.summaries);
    if (!existsSync(p)) throw new Error(`--summaries file not found: ${p}`);
    sumMap = readSummaries(p);
  }
  const missingZh = [];
  for (const b of boards) {
    for (const it of b.items) {
      const hit = sumMap.get(String(it.full_name).toLowerCase());
      if (hit) it.zh = hit;
      if (!it.zh || !String(it.zh).trim()) missingZh.push(it.full_name);
    }
  }
  if (missingZh.length) {
    warnings.push(`${missingZh.length} item(s) have no Chinese summary (zh); the English description is used instead: ${missingZh.slice(0, 6).join(', ')}${missingZh.length > 6 ? ' …' : ''}`);
  }

  // --- layout maths ---
  const stack = o.layout === 'stack' || (o.layout === 'auto' && o.height > o.width);
  const colCount = stack
    ? clamp(1, boards.length, 4)
    : o.columns === 'auto'
      ? clamp(1, boards.length, 3)
      : clamp(1, o.columns, 3);
  const shown = boards.slice(0, colCount);
  if (boards.length > colCount) warnings.push(`Data has ${boards.length} boards but only ${colCount} are rendered.`);

  const maxRows = o.limit
    ? clamp(1, o.limit, 25)
    : clamp(1, Math.max(...shown.map((b) => b.items.length)), 12);
  for (const b of shown) {
    if (b.items.length > maxRows) warnings.push(`${b.label}: ${b.items.length} items trimmed to ${maxRows} rows.`);
    if (b.items.length === 0) warnings.push(`${b.label}: no items, column renders an empty state.`);
  }

  const refWidth = stack ? 1080 : colCount === 1 ? 820 : 1600;
  const uiScale = clamp(0.72, Math.min(o.width / refWidth, o.height / 900), 1.6);
  const s = (v) => Math.round(v * uiScale * 10) / 10;

  const padY = Math.round(34 * uiScale);
  const padX = Math.round(stack || colCount === 1 ? 34 * uiScale : 40 * uiScale);
  // The template distributes row height with flexbox, so the browser has the
  // final say about geometry. These numbers only (a) cap how tall a row may
  // become when a board has few items and (b) pre-decide compact mode for
  // browsers without container-query support.
  const themeOverhead = THEME_OVERHEAD[o.theme] ?? DEFAULT_OVERHEAD;
  const overhead = Math.round(
    (stack
      ? themeOverhead - 100 + 60 * shown.length
      : colCount === 1
        ? themeOverhead - 20
        : themeOverhead) * uiScale,
  ); // body padding + header + footer + per-board chrome
  const boardAvail = stack ? (o.height - overhead) / Math.max(1, shown.length) : o.height - overhead;
  const estRowH = Math.floor(Math.max(0, boardAvail) / maxRows);
  const rowCap = Math.round(88 * uiScale);
  const compactBelow = Math.round(52 * uiScale);
  const rowH = o.rowH
    ? Math.round(o.rowH)
    : clamp(34, Math.max(estRowH, rowCap), Math.round(240 * uiScale));
  const compact = estRowH < compactBelow;
  if (compact) warnings.push(`Estimated row height ${estRowH}px is below ${compactBelow}px: description lines are hidden (compact mode). Use a smaller --limit or a taller --height to show them.`);
  if (estRowH < 34) warnings.push(`Estimated row height ${estRowH}px is very small; text may clip inside rows. Reduce --limit or increase --height.`);

  // --- text defaults ---
  const now = new Date();
  const localDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const labels = shown.map((b) => b.label || BOARD_EN[b.since] || b.since).join(' / ');
  const subtitle = o.subtitle ?? `开源热榜 · ${labels} · Top ${maxRows}`;
  const dateLine = o.date ?? localDate;
  const filters = data.filters || {};
  const filterBits = [
    filters.language ? `语言 ${filters.language}` : '全语言',
    filters.topic ? `话题 ${filters.topic}` : null,
    filters.spoken_language_code ? `口语 ${filters.spoken_language_code}` : null,
  ].filter(Boolean).join(' · ');
  const srcSet = [...new Set(shown.map((b) => b.source).filter(Boolean))];
  const metaLine = o.meta ?? `${filterBits} · 来源 ${srcSet.join('+') || 'github.com/trending'}`;
  const footerLeft = o.footerLeft ?? `数据来源 github.com/trending · 榜单为抓取时刻快照，star 数以页面展示为准`;
  const footerRight = o.footerRight ?? `生成于 ${now.toLocaleString('zh-CN', { hour12: false })}`;

  // --- theme ---
  const themesDir = resolve(join(SCRIPT_DIR, '..', 'assets', 'themes'));
  const themeCssPath = join(themesDir, `${o.theme}.css`);
  if (!existsSync(themeCssPath)) {
    let avail = [];
    try {
      avail = readdirSync(themesDir).filter((f) => f.endsWith('.css')).map((f) => f.replace(/\.css$/, ''));
    } catch { /* themesDir missing */ }
    throw new Error(
      `Unknown --theme "${o.theme}". Available theme(s): ${avail.length ? avail.join(', ') : 'none found'}. ` +
      `A theme is assets/themes/<name>.css plus optional <name>.bg.html / <name>.head.html decorations.`,
    );
  }
  const themeCss = readFileSync(themeCssPath, 'utf8');
  const decorBgPath = join(themesDir, `${o.theme}.bg.html`);
  const decorHeadPath = join(themesDir, `${o.theme}.head.html`);
  const decorBg = existsSync(decorBgPath)
    ? readFileSync(decorBgPath, 'utf8').trim()
    : '<div class="decor" aria-hidden="true"></div>';
  const decorHead = existsSync(decorHeadPath) ? readFileSync(decorHeadPath, 'utf8').trim() : '';

  // --- template ---
  const tplPath = resolve(o.template || join(SCRIPT_DIR, '..', 'assets', 'cover-template.html'));
  if (!existsSync(tplPath)) throw new Error(`Template not found: ${tplPath}`);
  const tpl = readFileSync(tplPath, 'utf8');

  const fsVars = {};
  for (const [k, v] of Object.entries(BASE_FS)) fsVars[`${k}_FS`] = s(v);

  const html = fillTemplate(tpl, {
    WIDTH: o.width,
    HEIGHT: o.height,
    ROW_H: rowH,
    COMPACT_BELOW: compactBelow,
    PAD_X: padX,
    PAD_Y: padY,
    COL_COUNT: colCount,
    COLS_CLASS: stack ? 'vertical' : '',
    BODY_CLASS: `theme-${o.theme}${compact ? ' compact' : ''}`,
    THEME_NAME: o.theme,
    THEME_CSS: themeCss,
    DECOR_BG: decorBg,
    DECOR_HEAD: decorHead,
    TITLE: esc(o.title),
    SUBTITLE: esc(subtitle),
    DATE_LINE: esc(dateLine),
    META_LINE: esc(metaLine),
    FOOTER_LEFT: esc(footerLeft),
    FOOTER_RIGHT: esc(footerRight),
    COLUMNS: shown.map((b, i) => columnHtml(b, i, maxRows, uiScale)).join('\n'),
    ...fsVars,
  });

  // --- write html ---
  const outPath = resolve(o.out);
  mkdirSync(dirname(outPath), { recursive: true });
  const htmlPath = o.htmlOut ? resolve(o.htmlOut) : `${outPath}.html`;
  writeFileSync(htmlPath, html, 'utf8');

  // --- screenshot ---
  const browser = findBrowser(o.browser);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    `--force-device-scale-factor=${o.scale}`,
    `--window-size=${o.width},${o.height}`,
    `--screenshot=${outPath}`,
    `file:///${htmlPath.replace(/\\/g, '/')}`,
  ];
  if (existsSync(outPath)) unlinkSync(outPath);

  const res = runBrowser(browser, args, { timeout: o.timeout, attempts: 2 });
  if (res.error) {
    throw new Error(
      `Failed to launch browser after ${res.attempts} attempt(s) (${browser}): ${res.error.message}\n` +
      'Close other Chrome instances, raise --timeout, or pass --browser "<path to chrome|edge>".',
    );
  }
  if (!existsSync(outPath)) {
    const err = `${res.stderr}${res.stdout}`.trim().split('\n').slice(-6).join('\n');
    throw new Error(`Browser did not produce ${outPath} (exit ${res.status}, attempts ${res.attempts}).\n${err}`);
  }
  const bytes = statSync(outPath).size;
  if (bytes < 1024) throw new Error(`Screenshot looks empty (${bytes} bytes): ${outPath}`);
  const dims = pngSize(outPath);

  if (!o.keepHtml && !o.htmlOut) {
    try { unlinkSync(htmlPath); } catch { /* ignore */ }
  }

  if (o.quiet) {
    process.stdout.write(`${outPath}\n`);
  } else {
    process.stdout.write(`Wrote ${outPath}\n`);
    process.stdout.write(`  size=${(bytes / 1024).toFixed(0)}KB pixels=${dims ? `${dims.width}x${dims.height}` : 'unknown'} canvas=${o.width}x${o.height} theme=${o.theme} layout=${stack ? 'stack' : 'columns'} boards=${colCount} rows<=${maxRows} estRowH=${estRowH}px rowCap=${rowH}px uiScale=${uiScale.toFixed(2)}${compact ? ' compact' : ''}\n`);
    process.stdout.write(`  browser=${browser}\n`);
    if (o.keepHtml || o.htmlOut) process.stdout.write(`  html=${htmlPath}\n`);
    for (const w of warnings) process.stdout.write(`  warn: ${w}\n`);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
