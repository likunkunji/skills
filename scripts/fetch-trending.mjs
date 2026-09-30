#!/usr/bin/env node
/**
 * Fetch GitHub Trending boards (daily / weekly) and normalize them to one JSON file.
 *
 * Usage:
 *   node fetch-trending.mjs --out data.json
 *   node fetch-trending.mjs --out data.json --since daily,weekly --limit 10
 *   node fetch-trending.mjs --out data.json --language python --since daily
 *   node fetch-trending.mjs --out data.json --topic ai-agent --since weekly
 *
 * Options:
 *   --out       <path>    Required. JSON output path (parent dirs are created).
 *   --since     <list>    Comma separated: daily, weekly, monthly. Default "daily,weekly".
 *   --limit     <n>       Items kept per board. Default 10.
 *   --language  <slug>    GitHub trending language filter, e.g. python, typescript, go.
 *   --topic     <slug>    Topic filter. Trending HTML has no topic support, so this
 *                         routes the board to the GitHub Search API (approximate).
 *   --spoken    <code>    Spoken language code, e.g. zh, en.
 *   --source    <mode>    auto (default) | trending | api
 *   --retries   <n>       HTTP retries per request. Default 2.
 *   --timeout   <ms>      Per request timeout. Default 25000.
 *   --quiet               Suppress the human readable summary on stdout.
 *
 * Environment:
 *   GITHUB_TOKEN   Optional. Raises Search API rate limit for the fallback path.
 *
 * Primary source is the HTML page https://github.com/trending (the only source that
 * exposes "stars today" / "stars this week"). If it fails or yields no rows, the
 * board falls back to the Search API sorted by stars over recently created repos,
 * which is marked approximate: true.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PERIOD_LABEL = {
  daily: '今日新增',
  weekly: '本周新增',
  monthly: '本月新增',
};

const BOARD_LABEL = {
  daily: '日榜',
  weekly: '周榜',
  monthly: '月榜',
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    out: null,
    since: ['daily', 'weekly'],
    limit: 10,
    language: null,
    topic: null,
    spoken: null,
    source: 'auto',
    retries: 2,
    timeout: 25000,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--out': opts.out = next(); break;
      case '--since': opts.since = String(next()).split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--limit': opts.limit = Number(next()); break;
      case '--language': opts.language = next(); break;
      case '--topic': opts.topic = next(); break;
      case '--spoken': opts.spoken = next(); break;
      case '--source': opts.source = next(); break;
      case '--retries': opts.retries = Number(next()); break;
      case '--timeout': opts.timeout = Number(next()); break;
      case '--quiet': opts.quiet = true; break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (opts.help) return opts;
  if (!opts.out) throw new Error('--out <path> is required');
  if (!Number.isFinite(opts.limit) || opts.limit < 1) throw new Error('--limit must be >= 1');
  for (const s of opts.since) {
    if (!['daily', 'weekly', 'monthly'].includes(s)) {
      throw new Error(`Invalid --since value "${s}" (use daily, weekly or monthly)`);
    }
  }
  if (!['auto', 'trending', 'api'].includes(opts.source)) {
    throw new Error(`Invalid --source "${opts.source}" (use auto, trending or api)`);
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' '));
}

function toInt(s) {
  if (s === null || s === undefined) return null;
  const n = Number(String(s).replace(/[, _]/g, ''));
  return Number.isFinite(n) ? Math.round(n) : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchText(url, { retries = 2, timeout = 25000, headers = {} } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return { body, status: res.status, url: res.url || url };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(700 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------------------------------------------------------------------------
// Trending HTML parsing
// ---------------------------------------------------------------------------

/**
 * Parse the trending page into normalized items.
 * Each repo lives in `<article class="Box-row">...</article>`.
 */
export function parseTrendingHtml(html, limit = Infinity) {
  const blocks = String(html).match(/<article[\s\S]*?<\/article>/g) || [];
  const items = [];

  for (const block of blocks) {
    const nameM = block.match(/<h2[\s\S]*?<a[^>]*href="\/([^"?#]+)/);
    if (!nameM) continue;
    const fullName = decodeEntities(nameM[1]).replace(/^\/+|\/+$/g, '');
    if (!fullName.includes('/')) continue;

    const descM = block.match(/<p[^>]*class="[^"]*col-9[^"]*"[\s\S]*?>([\s\S]*?)<\/p>/);
    const langM = block.match(/itemprop="programmingLanguage"[^>]*>([\s\S]*?)</);
    const colorM = block.match(/repo-language-color[^>]*background-color:\s*(#[0-9a-fA-F]{3,8})/);
    const starsM =
      block.match(/\/stargazers"[\s\S]*?<\/svg>\s*([\d,]+)/) ||
      block.match(/\/stargazers"[^>]*>(?:\s*<[^>]*>)*\s*([\d,]+)/);
    const forksM =
      block.match(/\/(?:forks|network\/members)"[\s\S]*?<\/svg>\s*([\d,]+)/) ||
      block.match(/\/(?:forks|network\/members)"[^>]*>(?:\s*<[^>]*>)*\s*([\d,]+)/);
    const periodM = block.match(/([\d,]+)\s+stars?\s+(today|this week|this month)/i);
    const builtBy = [...block.matchAll(/alt="@([^"]+)"/g)].map((m) => m[1]);

    const [owner, ...rest] = fullName.split('/');
    items.push({
      full_name: fullName,
      owner,
      name: rest.join('/'),
      url: `https://github.com/${fullName}`,
      description: descM ? stripTags(descM[1]).replace(/\s+/g, ' ').trim() : '',
      language: langM ? decodeEntities(langM[1]).trim() : null,
      language_color: colorM ? colorM[1] : null,
      stars: starsM ? toInt(starsM[1]) : null,
      forks: forksM ? toInt(forksM[1]) : null,
      period_stars: periodM ? toInt(periodM[1]) : null,
      period_label_en: periodM ? periodM[2].toLowerCase() : null,
      built_by: builtBy,
      zh: null,
    });

    if (items.length >= limit) break;
  }

  return items;
}

function trendingUrl({ since, language, spoken }) {
  const base = 'https://github.com/trending';
  const path = language ? `${base}/${encodeURIComponent(language)}` : base;
  const q = new URLSearchParams({ since });
  if (spoken) q.set('spoken_language_code', spoken);
  return `${path}?${q.toString()}`;
}

// ---------------------------------------------------------------------------
// Search API fallback (also the only path that supports --topic)
// ---------------------------------------------------------------------------

async function fetchViaSearchApi({ since, language, topic, limit, retries, timeout }) {
  const days = since === 'weekly' ? 7 : since === 'monthly' ? 30 : 2;
  const sinceDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const q = [`created:>${sinceDate}`];
  if (language) q.push(`language:${language}`);
  if (topic) q.push(`topic:${topic}`);

  const url =
    'https://api.github.com/search/repositories?' +
    new URLSearchParams({
      q: q.join(' '),
      sort: 'stars',
      order: 'desc',
      per_page: String(Math.min(Math.max(limit * 2, 10), 100)),
    }).toString();

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const { body } = await fetchText(url, { retries, timeout, headers });
  const json = JSON.parse(body);
  const raw = Array.isArray(json.items) ? json.items : [];

  return {
    approximate: true,
    note: `Search API approximation: repos created after ${sinceDate}, sorted by total stars.`,
    items: raw.slice(0, limit).map((r) => ({
      full_name: r.full_name,
      owner: r.owner?.login ?? r.full_name.split('/')[0],
      name: r.name,
      url: r.html_url,
      description: (r.description || '').replace(/\s+/g, ' ').trim(),
      language: r.language || null,
      language_color: null,
      stars: r.stargazers_count ?? null,
      forks: r.forks_count ?? null,
      period_stars: null,
      period_label_en: null,
      built_by: [],
      zh: null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function buildBoard(since, opts) {
  const board = {
    since,
    label: BOARD_LABEL[since] || since,
    period_label: PERIOD_LABEL[since] || '新增 star',
    source: null,
    url: null,
    fetched_at: new Date().toISOString(),
    approximate: false,
    note: null,
    items: [],
    error: null,
  };

  const useApi = opts.source === 'api' || Boolean(opts.topic);

  if (!useApi) {
    const url = trendingUrl({ since, language: opts.language, spoken: opts.spoken });
    board.url = url;
    try {
      const { body } = await fetchText(url, { retries: opts.retries, timeout: opts.timeout });
      const items = parseTrendingHtml(body, opts.limit);
      if (items.length > 0) {
        board.source = 'github-trending-html';
        board.items = items.map((it, i) => ({ rank: i + 1, ...it }));
        return board;
      }
      board.error = 'Trending page fetched but no <article class="Box-row"> rows were parsed.';
    } catch (err) {
      board.error = `Trending fetch failed: ${err.message}`;
    }
    if (opts.source === 'trending') return board; // caller asked for HTML only
  }

  try {
    const fb = await fetchViaSearchApi({
      since,
      language: opts.language,
      topic: opts.topic,
      limit: opts.limit,
      retries: opts.retries,
      timeout: opts.timeout,
    });
    board.source = 'github-search-api';
    board.approximate = fb.approximate;
    board.note = fb.note;
    if (!board.url) board.url = 'https://api.github.com/search/repositories';
    board.items = fb.items.map((it, i) => ({ rank: i + 1, ...it }));
    if (board.error) board.note = `${board.note} (fallback reason: ${board.error})`;
    board.error = null;
  } catch (err) {
    board.error = board.error ? `${board.error} | Search API also failed: ${err.message}` : `Search API failed: ${err.message}`;
  }
  return board;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(
      [
        'Usage: node fetch-trending.mjs --out data.json [--since daily,weekly] [--limit 10]',
        '                               [--language python] [--topic ai] [--spoken zh]',
        '                               [--source auto|trending|api] [--retries 2] [--timeout 25000] [--quiet]',
        '',
      ].join('\n'),
    );
    return;
  }

  const boards = [];
  for (const since of opts.since) {
    boards.push(await buildBoard(since, opts)); // sequential: be polite to github.com
  }

  const payload = {
    generated_at: new Date().toISOString(),
    filters: { language: opts.language, topic: opts.topic, spoken_language_code: opts.spoken },
    limit: opts.limit,
    boards,
  };

  const outPath = resolve(opts.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');

  if (!opts.quiet) {
    process.stdout.write(`Wrote ${outPath}\n`);
    for (const b of boards) {
      const head = `- ${b.label}(${b.since}) source=${b.source ?? 'none'} items=${b.items.length}`;
      process.stdout.write(`${head}${b.approximate ? ' [approximate]' : ''}\n`);
      if (b.error) process.stdout.write(`  error: ${b.error}\n`);
      for (const it of b.items.slice(0, 3)) {
        const p = it.period_stars !== null ? ` +${it.period_stars}` : '';
        process.stdout.write(`  ${String(it.rank).padStart(2)}. ${it.full_name} ★${it.stars ?? '?'}${p} [${it.language || '-'}]\n`);
      }
    }
    const missing = boards.flatMap((b) => b.items).filter((i) => !i.description).length;
    if (missing) process.stdout.write(`note: ${missing} item(s) had no description on the page\n`);
    const failed = boards.filter((b) => b.items.length === 0).length;
    if (failed === boards.length) {
      process.stderr.write('All boards are empty. Check network/proxy, or set GITHUB_TOKEN and retry with --source api.\n');
      process.exitCode = 2;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
