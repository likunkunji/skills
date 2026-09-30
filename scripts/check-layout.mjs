#!/usr/bin/env node
/**
 * Verify a rendered cover HTML for clipping and text truncation.
 *
 * The chat UI displays images but does not feed pixels back to the model, so
 * layout quality has to be checked programmatically. This script re-opens the
 * filled HTML in headless Chromium, measures the real layout, and prints a
 * PASS / WARN / FAIL verdict.
 *
 * Viewport calibration: `--dump-dom` reports a smaller viewport than
 * `--screenshot` for the same --window-size (window decorations and a reserved
 * scrollbar), which would produce false overflow failures. The script therefore
 * measures the offset on a first pass and re-measures with a corrected
 * --window-size so the probe sees exactly the intended CSS viewport.
 *
 * Usage:
 *   node check-layout.mjs --html cover.png.html
 *   node check-layout.mjs --html cover.png.html --width 1600 --height 900 --scale 2 --json probe.json
 *
 * Options:
 *   --html     <path>  Required. Filled HTML written by render-cover.mjs.
 *   --width    <px>    Default 1600.
 *   --height   <px>    Default 900.
 *   --scale    <n>     Device scale factor. Default 2, matching render-cover.mjs.
 *   --browser  <mode>  auto (default) | chrome | edge | <absolute path>.
 *   --timeout  <ms>    Default 60000.
 *   --json     <path>  Optional. Also write the raw measurement JSON here.
 *   --quiet            Print only the verdict line.
 *
 * Exit codes: 0 = PASS or WARN, 3 = FAIL (clipped content or page overflow),
 *             1 = the check itself could not run.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { findBrowser, runBrowser } from './browser.mjs';

const PROBE_ID = '__gtc_probe__';

const PROBE_SCRIPT = `
<script>
(function () {
  function run() {
    var out = { body: {}, columns: [], truncation: { name: 0, desc: 0, tag: 0, colNote: 0, samples: [] } };
    var de = document.documentElement, b = document.body;
    out.body = {
      scrollW: de.scrollWidth, clientW: de.clientWidth,
      scrollH: de.scrollHeight, clientH: de.clientHeight,
      bodyScrollH: b.scrollHeight, bodyClientH: b.clientHeight,
      innerW: window.innerWidth, innerH: window.innerHeight, dpr: window.devicePixelRatio
    };
    function scan(sel, key) {
      var els = document.querySelectorAll(sel);
      for (var j = 0; j < els.length; j += 1) {
        var el = els[j];
        if (el.scrollWidth > el.clientWidth + 1) {
          out.truncation[key] += 1;
          if (out.truncation.samples.length < 6) {
            out.truncation.samples.push({
              where: key, text: el.textContent.trim().slice(0, 46),
              scrollW: el.scrollWidth, clientW: el.clientWidth
            });
          }
        }
      }
    }
    var cols = document.querySelectorAll('.col');
    for (var i = 0; i < cols.length; i += 1) {
      var col = cols[i];
      var list = col.querySelector('.list');
      var rows = col.querySelectorAll('.row');
      var listRect = list ? list.getBoundingClientRect() : null;
      var clipped = 0, contentClipped = 0, descShown = 0, descTotal = 0, rowH = null, worstBottom = 0;
      for (var r = 0; r < rows.length; r += 1) {
        var rect = rows[r].getBoundingClientRect();
        if (rowH === null) rowH = Math.round(rect.height * 10) / 10;
        worstBottom = Math.max(worstBottom, rect.bottom);
        if (listRect && rect.bottom > listRect.bottom + 0.5) clipped += 1;
        var main = rows[r].querySelector('.main');
        if (main && main.scrollHeight > main.clientHeight + 1) contentClipped += 1;
        var l2 = rows[r].querySelector('.l2');
        if (l2) { descTotal += 1; if (l2.getClientRects().length > 0) descShown += 1; }
      }
      var chip = col.querySelector('.chip');
      out.columns.push({
        title: chip ? chip.textContent.trim() : ('col' + (i + 1)),
        rows: rows.length, rowH: rowH,
        clippedRows: clipped, contentClippedRows: contentClipped,
        descTotal: descTotal, descShown: descShown,
        listScrollH: list ? list.scrollHeight : null,
        listClientH: list ? list.clientHeight : null,
        listBottom: listRect ? Math.round(listRect.bottom) : null,
        worstRowBottom: Math.round(worstBottom),
        colScrollH: col.scrollHeight, colClientH: col.clientHeight
      });
    }
    scan('.name', 'name');
    scan('.l2', 'desc');
    scan('.tag', 'tag');
    scan('.col-note', 'colNote');
    var pre = document.createElement('pre');
    pre.id = '${PROBE_ID}';
    pre.setAttribute('hidden', '');
    pre.textContent = JSON.stringify(out);
    document.body.appendChild(pre);
  }
  setTimeout(function () { try { run(); } catch (e) { window.__PROBE_ERROR__ = String(e); } }, 80);
}());
</script>
`;

function parseArgs(argv) {
  const o = { html: null, width: 1600, height: 900, scale: 2, browser: 'auto', timeout: 60000, json: null, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--html': o.html = next(); break;
      case '--width': o.width = Number(next()); break;
      case '--height': o.height = Number(next()); break;
      case '--scale': o.scale = Number(next()); break;
      case '--browser': o.browser = next(); break;
      case '--timeout': o.timeout = Number(next()); break;
      case '--json': o.json = next(); break;
      case '--quiet': o.quiet = true; break;
      default: throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!o.html) throw new Error('--html <path> is required');
  return o;
}

/** Launch the browser once and return the parsed measurement. */
function measure(browser, probePath, o, winW, winH) {
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio',
    '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check',
    '--virtual-time-budget=4000',
    `--force-device-scale-factor=${o.scale}`,
    `--window-size=${winW},${winH}`,
    '--dump-dom',
    `file:///${probePath.replace(/\\/g, '/')}`,
  ];
  const res = runBrowser(browser, args, { timeout: o.timeout, attempts: 2 });
  if (res.error) throw new Error(`Failed to launch browser (${browser}): ${res.error.message}`);
  const dom = res.stdout || '';
  const m = dom.match(new RegExp(`<pre id="${PROBE_ID}"[^>]*>([\\s\\S]*?)</pre>`));
  if (!m) {
    throw new Error(`Probe produced no measurement data (browser exit ${res.status}). Last stderr:\n` +
      res.stderr.trim().split('\n').slice(-5).join('\n'));
  }
  const raw = m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return JSON.parse(raw);
}

function viewportError(p, w, h) {
  const b = p.body || {};
  return Math.abs((b.innerW ?? 0) - w) + Math.abs((b.innerH ?? 0) - h);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const src = resolve(o.html);
  if (!existsSync(src)) throw new Error(`HTML not found: ${src}`);

  let html = readFileSync(src, 'utf8');
  if (!html.includes('</body>')) throw new Error(`${src} has no </body>; is it a cover HTML file?`);
  html = html.replace('</body>', `${PROBE_SCRIPT}</body>`);
  const probePath = `${src}.probe.html`;
  writeFileSync(probePath, html, 'utf8');

  let p;
  let calibrated = false;
  let calibNote = '';
  try {
    const browser = findBrowser(o.browser);
    p = measure(browser, probePath, o, o.width, o.height);

    const b = p.body || {};
    const dw = o.width - (b.innerW ?? o.width);
    const dh = o.height - (b.innerH ?? o.height);
    if ((dw !== 0 || dh !== 0) && Math.abs(dw) <= 300 && Math.abs(dh) <= 400) {
      const p2 = measure(browser, probePath, o, o.width + dw, o.height + dh);
      if (viewportError(p2, o.width, o.height) < viewportError(p, o.width, o.height)) {
        p = p2;
        calibrated = true;
        calibNote = `viewport calibrated with window-size=${o.width + dw}x${o.height + dh} (decoration offset ${dw}x${dh})`;
      } else {
        calibNote = `could not calibrate viewport to ${o.width}x${o.height}; measured ${(b.innerW ?? '?')}x${(b.innerH ?? '?')} (offset ${dw}x${dh}); overflow verdict may be off`;
      }
    }
  } finally {
    try { if (existsSync(probePath)) unlinkSync(probePath); } catch { /* ignore */ }
  }

  if (o.json) {
    mkdirSync(dirname(resolve(o.json)), { recursive: true });
    writeFileSync(resolve(o.json), JSON.stringify(p, null, 2), 'utf8');
  }

  const fails = [];
  const warns = [];
  const notes = [];
  const b = p.body || {};
  if (calibNote) notes.push(calibNote);

  if (b.innerW === o.width && b.innerH === o.height) {
    if (b.scrollH > b.clientH + 1 || b.bodyScrollH > b.bodyClientH + 1) {
      fails.push(`Page overflows vertically: scrollH=${b.scrollH} clientH=${b.clientH}`);
    }
    if (b.scrollW > b.clientW + 1) fails.push(`Page overflows horizontally: scrollW=${b.scrollW} clientW=${b.clientW}`);
  } else {
    warns.push(`Measured viewport ${b.innerW}x${b.innerH} != target ${o.width}x${o.height}; page-level overflow not judged.`);
  }

  for (const c of p.columns || []) {
    if (c.clippedRows > 0) fails.push(`${c.title}: ${c.clippedRows} row(s) clipped below the list box`);
    if (c.contentClippedRows > 0) fails.push(`${c.title}: ${c.contentClippedRows} row(s) have text taller than the row box`);
    if (c.listScrollH !== null && c.listClientH !== null && c.listScrollH > c.listClientH + 1) {
      fails.push(`${c.title}: list content ${c.listScrollH}px exceeds visible ${c.listClientH}px`);
    }
    if (c.rows === 0) warns.push(`${c.title}: rendered 0 rows`);
    if (c.descTotal > 0 && c.descShown === 0) warns.push(`${c.title}: all description lines hidden (compact)`);
  }
  const t = p.truncation || {};
  if (t.desc > 0) warns.push(`${t.desc} Chinese summary line(s) ellipsised (shorten the wording to fit)`);
  if (t.name > 0) warns.push(`${t.name} repo name(s) ellipsised (usually acceptable for long owner/repo)`);
  if (t.tag > 0) warns.push(`${t.tag} language tag(s) ellipsised`);
  if (t.colNote > 0) warns.push(`${t.colNote} column note(s) ellipsised`);

  const verdict = fails.length ? 'FAIL' : warns.length ? 'WARN' : 'PASS';

  if (o.quiet) {
    process.stdout.write(`${verdict}\n`);
  } else {
    process.stdout.write(`Layout check: ${verdict}  (target ${o.width}x${o.height}, scale ${o.scale})\n`);
    process.stdout.write(`  page: scroll=${b.scrollW}x${b.scrollH} client=${b.clientW}x${b.clientH} inner=${b.innerW}x${b.innerH} dpr=${b.dpr}\n`);
    for (const c of p.columns || []) {
      process.stdout.write(`  column "${c.title}": rows=${c.rows} rowH=${c.rowH}px clipped=${c.clippedRows} contentClipped=${c.contentClippedRows} list=${c.listScrollH}/${c.listClientH}px desc=${c.descShown}/${c.descTotal}\n`);
    }
    process.stdout.write(`  truncation: name=${t.name ?? 0} desc=${t.desc ?? 0} tag=${t.tag ?? 0} colNote=${t.colNote ?? 0}\n`);
    for (const s of (t.samples || []).slice(0, 4)) {
      process.stdout.write(`    ellipsised ${s.where}: "${s.text}" (${s.scrollW}>${s.clientW})\n`);
    }
    for (const f of fails) process.stdout.write(`  FAIL: ${f}\n`);
    for (const w of warns) process.stdout.write(`  warn: ${w}\n`);
    for (const n of notes) process.stdout.write(`  note: ${n}\n`);
    if (verdict === 'FAIL') {
      process.stdout.write('  fix: lower --limit, raise --height, or shorten summaries; then re-render and re-check.\n');
    }
  }
  if (verdict === 'FAIL') process.exitCode = 3;
}

try {
  main();
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
}
