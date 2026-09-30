/**
 * Shared headless-Chromium launcher for the github-trending-cover skill.
 *
 * Two details matter on real machines:
 *  1. A unique --user-data-dir per launch. Without it, headless Chrome reuses the
 *     default profile and can block on the profile lock held by the browser the
 *     user already has open, which shows up as spawnSync ETIMEDOUT.
 *  2. One retry with a fresh profile, because the first launch occasionally loses
 *     a race right after another headless instance exited.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Resolve a Chrome/Edge executable. mode: auto | chrome | edge | <absolute path>. */
export function findBrowser(mode = 'auto') {
  const win = process.platform === 'win32';
  const pf = win ? process.env.ProgramFiles || 'C:\\Program Files' : null;
  const pfx86 = win ? process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)' : null;
  const localApp = win ? process.env.LOCALAPPDATA || '' : '';

  const chrome = win
    ? [
        pf && join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        pfx86 && join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        localApp && join(localApp, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      ];

  const edge = win
    ? [
        pfx86 && join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        pf && join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ]
    : [
        '/usr/bin/microsoft-edge',
        '/usr/bin/microsoft-edge-stable',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ];

  const isMode = ['auto', 'chrome', 'edge'].includes(mode);
  if (!isMode) {
    const p = resolve(mode);
    if (!existsSync(p)) throw new Error(`--browser path not found: ${mode}`);
    return p;
  }

  const envPath = process.env.CHROME_PATH || process.env.GTC_BROWSER;
  if (mode === 'auto' && envPath && existsSync(envPath)) return resolve(envPath);

  const groups = mode === 'chrome' ? [chrome] : mode === 'edge' ? [edge] : [chrome, edge];
  for (const group of groups) {
    for (const candidate of group) {
      if (candidate && existsSync(candidate)) return candidate;
    }
  }
  if (mode === 'auto' && envPath) return resolve(envPath);

  throw new Error(
    'No Chromium browser found. Install Google Chrome or Microsoft Edge, ' +
      'or pass --browser "<path to executable>" (or set CHROME_PATH).',
  );
}

/**
 * Launch the browser with an isolated temporary profile.
 * @returns {{status:number|null, stdout:string, stderr:string, error:Error|null, attempts:number, profile:string}}
 */
export function runBrowser(browser, args, { timeout = 60000, attempts = 2 } = {}) {
  let last = null;
  for (let i = 0; i < Math.max(1, attempts); i += 1) {
    let profile = null;
    try {
      profile = mkdtempSync(join(tmpdir(), 'gtc-chrome-'));
    } catch {
      profile = null; // fall back to the browser default profile
    }
    const fullArgs = profile ? [...args, `--user-data-dir=${profile}`] : args;
    const res = spawnSync(browser, fullArgs, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    last = {
      status: res.status,
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      error: res.error || null,
      attempts: i + 1,
      profile: profile || '(default)',
    };
    if (profile) {
      try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    const timedOut = res.error && res.error.code === 'ETIMEDOUT';
    if (!res.error && !timedOut) return last;
    if (timedOut) last.stderr = `${last.stderr}\n(launch timed out after ${timeout}ms)`.trim();
  }
  return last;
}
