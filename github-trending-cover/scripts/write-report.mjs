#!/usr/bin/env node
/**
 * Write a Markdown report from the normalized board JSON.
 *
 * Usage:
 *   node write-report.mjs --data data.json --out report.md
 *   node write-report.mjs --data data.json --summaries summaries.json --out report.md --title "GitHub 热榜"
 *
 * Options:
 *   --data        <path>  Required. JSON produced by fetch-trending.mjs.
 *   --out         <path>  Required. Markdown output path (parent dirs are created).
 *   --summaries   <path>  Optional. Same file accepted by render-cover.mjs; Chinese
 *                         one-liners are used in place of English descriptions.
 *   --limit       <n>     Rows per board. Default: all items in the data.
 *   --title       <text>  Default "GitHub Trending 榜单".
 *   --no-desc             Omit the description/summary column (narrow tables).
 *   --quiet               Only print the output path.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function parseArgs(argv) {
  const o = { data: null, out: null, summaries: null, limit: null, title: 'GitHub Trending 榜单', desc: true, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--data': o.data = next(); break;
      case '--out': o.out = next(); break;
      case '--summaries': o.summaries = next(); break;
      case '--limit': o.limit = Number(next()); break;
      case '--title': o.title = next(); break;
      case '--no-desc': o.desc = false; break;
      case '--quiet': o.quiet = true; break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!o.data) throw new Error('--data <path> is required');
  if (!o.out) throw new Error('--out <path> is required');
  return o;
}

function readSummaries(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const map = new Map();
  const put = (k, v) => { if (k && v) map.set(String(k).toLowerCase(), String(v).trim()); };
  if (Array.isArray(raw)) {
    for (const e of raw) put(e.full_name || e.repo || e.name, e.zh || e.summary || e.text);
  } else if (raw && typeof raw === 'object') {
    const entries = raw.summaries && typeof raw.summaries === 'object' ? raw.summaries : raw;
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v === 'string') put(k, v);
      else if (v && typeof v === 'object') put(k, v.zh || v.summary);
    }
  }
  return map;
}

const num = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('en-US'));

/** Escape pipes and collapse whitespace so Markdown tables stay intact. */
function cell(s) {
  return String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim() || '—';
}

function link(item) {
  const url = item.url || `https://github.com/${item.full_name}`;
  return `[${cell(item.full_name)}](${url})`;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const data = JSON.parse(readFileSync(resolve(o.data), 'utf8'));
  const boards = Array.isArray(data.boards) ? data.boards : [];
  if (boards.length === 0) throw new Error('data.json contains no boards; re-run fetch-trending.mjs');

  let sums = new Map();
  if (o.summaries) {
    const p = resolve(o.summaries);
    if (!existsSync(p)) throw new Error(`--summaries file not found: ${p}`);
    sums = readSummaries(p);
  }

  const filters = data.filters || {};
  const filterBits = [
    filters.language ? `语言：\`${filters.language}\`` : '语言：全部',
    filters.topic ? `话题：\`${filters.topic}\`` : null,
    filters.spoken_language_code ? `口语：\`${filters.spoken_language_code}\`` : null,
  ].filter(Boolean).join(' ｜ ');

  const lines = [];
  lines.push(`# ${o.title}`);
  lines.push('');
  lines.push(`- 生成时间：${data.generated_at || new Date().toISOString()}`);
  lines.push(`- ${filterBits}`);
  lines.push(`- 榜单：${boards.map((b) => `${b.label || b.since}（${b.source || 'unknown'}${b.approximate ? '，近似' : ''}）`).join('、')}`);
  lines.push('');

  let missingZh = 0;
  for (const b of boards) {
    const items = (b.items || []).slice(0, o.limit || undefined);
    lines.push(`## ${b.label || b.since}（${b.since}）`);
    lines.push('');
    if (b.approximate || b.note) {
      lines.push(`> ${b.note}`);
      lines.push('');
    }
    if (b.error) {
      lines.push(`> 抓取异常：${b.error}`);
      lines.push('');
    }
    if (items.length === 0) {
      lines.push('_本次未取到数据。_');
      lines.push('');
      continue;
    }

    const head = o.desc
      ? '| # | 仓库 | 语言 | 总 Star | ' + (b.period_label || '新增 Star') + ' | Fork | 简介 |'
      : '| # | 仓库 | 语言 | 总 Star | ' + (b.period_label || '新增 Star') + ' | Fork |';
    const sep = o.desc ? '|---:|---|---|---:|---:|---:|---|' : '|---:|---|---|---:|---:|---:|';
    lines.push(head);
    lines.push(sep);

    for (const it of items) {
      const zh = sums.get(String(it.full_name).toLowerCase()) || it.zh;
      const text = zh || it.description;
      if (!zh && !it.description) missingZh += 1;
      const row = [
        it.rank,
        link(it),
        cell(it.language || '—'),
        num(it.stars),
        it.period_stars === null || it.period_stars === undefined ? '—' : `+${num(it.period_stars)}`,
        num(it.forks),
      ];
      if (o.desc) row.push(cell(text));
      lines.push(`| ${row.join(' | ')} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('数据来源：[github.com/trending](https://github.com/trending)。榜单为抓取时刻快照，star 数以页面展示为准；`新增` 为页面标注的 today / this week 增量。');
  lines.push('');

  const outPath = resolve(o.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, lines.join('\n'), 'utf8');

  if (o.quiet) {
    process.stdout.write(`${outPath}\n`);
  } else {
    const rows = boards.reduce((n, b) => n + (b.items || []).length, 0);
    process.stdout.write(`Wrote ${outPath}\n`);
    process.stdout.write(`  boards=${boards.length} rows=${rows}${o.desc ? ' with-descriptions' : ''}\n`);
    if (sums.size === 0) process.stdout.write('  note: no --summaries given, English descriptions are used\n');
    if (missingZh) process.stdout.write(`  warn: ${missingZh} row(s) had neither a Chinese summary nor a description\n`);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
