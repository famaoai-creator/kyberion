#!/usr/bin/env node

/**
 * Reusable before/after screenshot capture for Kyberion's 5 UI surfaces
 * (concierge, presence-studio, chronos-mirror-v2, operator-surface,
 * computer-surface). Written for the MSN-SURFACE-UI-UNIFY-20260923 mission
 * so the same script can capture "before" and "after" evidence.
 *
 * Usage:
 *   node --import ./scripts/ts-loader.mjs scripts/capture_surface_screenshots.ts \
 *     --out active/missions/public/MSN-SURFACE-UI-UNIFY-20260923/evidence/screenshots/before \
 *     [--themes light,dark] [--locales ja,en] [--width 1440] [--height 900] \
 *     [--surfaces concierge,operator-surface] [--set surfaces|pads|all] \
 *     [--base-url-map '{"concierge":"http://127.0.0.1:3050"}']
 *
 * Each page is opened with the browser locale, Accept-Language, the shared
 * `kyberion.ui.locale` / `kyberion.ui.theme` preferences and the
 * `kb-ui-locale` cookie set before load, then waits until loading
 * placeholders are gone so the shot shows real content.
 *
 * Assumes the 5 surfaces are already running locally (the caller is
 * responsible for starting/stopping them — see docs/SURFACES.md and
 * knowledge/product/governance/active-surfaces.json for how each one is
 * normally launched). Surfaces that gate on loopback-only access require:
 *   - env KYBERION_TRUST_PROXY=1 on the surface process
 *   - the `x-real-ip: 127.0.0.1` request header (set automatically below)
 *   - operator-surface additionally needs KYBERION_MOS_PRINCIPAL=human:operator
 *
 * `--set pads` captures the local pads instead (MSN-PADS-A2UI-20260923),
 * each started with `tsx scripts/<pad>/server.ts [port]` on its default port.
 */

import { chromium, type Browser, type BrowserContext } from 'playwright';
import { safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

type Theme = 'light' | 'dark';
type Locale = 'ja' | 'en';

interface PageSpec {
  surface: string;
  pageName: string;
  path: string;
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  concierge: 'http://127.0.0.1:3050',
  'presence-studio': 'http://127.0.0.1:3031',
  'chronos-mirror-v2': 'http://127.0.0.1:3000',
  'operator-surface': 'http://127.0.0.1:3331',
  'computer-surface': 'http://127.0.0.1:3040',
  'personal-pads': 'http://127.0.0.1:8160',
  'report-review': 'http://127.0.0.1:8137',
  'sketch-input': 'http://127.0.0.1:8147',
  'meeting-notepad': 'http://127.0.0.1:8148',
  'memory-capture': 'http://127.0.0.1:8149',
  'screenshot-annotate': 'http://127.0.0.1:8150',
  'clipboard-inbox': 'http://127.0.0.1:8151',
  'daily-desk': 'http://127.0.0.1:8152',
  'doc-drop': 'http://127.0.0.1:8153',
  'personal-workbench': 'http://127.0.0.1:8154',
};

const DEFAULT_PAGES: PageSpec[] = [
  { surface: 'concierge', pageName: 'home', path: '/' },
  { surface: 'concierge', pageName: 'settings', path: '/settings' },
  { surface: 'presence-studio', pageName: 'home', path: '/' },
  { surface: 'presence-studio', pageName: 'ask', path: '/ask' },
  { surface: 'presence-studio', pageName: 'progress', path: '/progress' },
  { surface: 'chronos-mirror-v2', pageName: 'home', path: '/' },
  // Chronos is a single-page console; other visualization scopes are
  // reachable by URL via `?section=<scope>` (see src/app/page.tsx).
  { surface: 'chronos-mirror-v2', pageName: 'governance', path: '/?section=governance' },
  { surface: 'chronos-mirror-v2', pageName: 'missions', path: '/?section=missions' },
  { surface: 'chronos-mirror-v2', pageName: 'operations', path: '/?section=operations' },
  // operator-surface's mission overview is the root page; /missions itself
  // has no index route (only /missions/[id]).
  { surface: 'operator-surface', pageName: 'missions', path: '/' },
  { surface: 'operator-surface', pageName: 'audit', path: '/audit' },
  { surface: 'computer-surface', pageName: 'home', path: '/' },
];

const PAD_PAGES: PageSpec[] = [
  'personal-pads',
  'report-review',
  'sketch-input',
  'meeting-notepad',
  'memory-capture',
  'screenshot-annotate',
  'clipboard-inbox',
  'daily-desk',
  'doc-drop',
  'personal-workbench',
].map((surface) => ({ surface, pageName: 'home', path: '/' }));

function pageSet(raw: string | undefined): PageSpec[] {
  if (raw === undefined || raw === 'surfaces') return DEFAULT_PAGES;
  if (raw === 'pads') return PAD_PAGES;
  if (raw === 'all') return [...DEFAULT_PAGES, ...PAD_PAGES];
  throw new ScriptExitError(1, `--set must be surfaces, pads or all (got ${raw})`);
}

interface CaptureResult {
  surface: string;
  pageName: string;
  theme: Theme;
  locale: Locale;
  status: 'ok' | 'failed';
  file?: string;
  error?: string;
}

function argument(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseThemes(raw: string | undefined): Theme[] {
  const themes = (raw ?? 'light,dark')
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is Theme => value === 'light' || value === 'dark');
  return themes.length > 0 ? themes : ['light', 'dark'];
}

function parseLocales(raw: string | undefined): Locale[] {
  const locales = (raw ?? 'ja')
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is Locale => value === 'ja' || value === 'en');
  return locales.length > 0 ? locales : ['ja'];
}

function parseBaseUrlMap(raw: string | undefined): Record<string, string> {
  if (!raw) return { ...DEFAULT_BASE_URLS };
  let overrides: Record<string, string> = {};
  try {
    overrides = JSON.parse(raw) as Record<string, string>;
  } catch (error) {
    throw new ScriptExitError(1, `--base-url-map is not valid JSON: ${(error as Error).message}`);
  }
  return { ...DEFAULT_BASE_URLS, ...overrides };
}

/** Text that must never leak into a screenshot: absolute repo checkout paths. */
function scrubNeedles(raw: string | undefined): string[] {
  const needles = new Set<string>([
    pathResolver.rootDir(),
    '/Volumes/data/forcheck/kyberion',
    '/Volumes/data/forcheck/kyberion-surface-ui',
  ]);
  if (raw) {
    for (const value of raw
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)) {
      needles.add(value);
    }
  }
  return [...needles];
}

async function scrubDomText(context: BrowserContext, needles: string[]): Promise<void> {
  await context.addInitScript((needleList: string[]) => {
    const scrub = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node: Node | null = walker.nextNode();
      while (node) {
        let text = node.textContent ?? '';
        let changed = false;
        for (const needle of needleList) {
          if (needle && text.includes(needle)) {
            text = text.split(needle).join('<repo>');
            changed = true;
          }
        }
        if (changed) node.textContent = text;
        node = walker.nextNode();
      }
    };
    // Scrub once DOM is interactive, and again shortly after in case of
    // client-side hydration replacing text nodes.
    document.addEventListener('DOMContentLoaded', scrub);
    window.setInterval(scrub, 500);
  }, needles);
}

async function captureOne(
  browser: Browser,
  spec: PageSpec,
  baseUrl: string,
  theme: Theme,
  locale: Locale,
  width: number,
  height: number,
  outDir: string,
  needles: string[]
): Promise<CaptureResult> {
  const url = `${baseUrl}${spec.path}`;
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: theme,
    locale: locale === 'ja' ? 'ja-JP' : 'en-US',
    extraHTTPHeaders: {
      'x-real-ip': '127.0.0.1',
      'accept-language': locale === 'ja' ? 'ja-JP,ja;q=0.9' : 'en-US,en;q=0.9',
    },
  });
  const origin = new URL(baseUrl);
  await context.addCookies([
    { name: 'kb-ui-locale', value: locale, domain: origin.hostname, path: '/' },
  ]);
  await context.addInitScript(
    ([prefLocale, prefTheme]: [string, string]) => {
      try {
        window.localStorage.setItem('kyberion.ui.locale', prefLocale);
        window.localStorage.setItem('kyberion.ui.theme', prefTheme);
      } catch {
        // Storage can be unavailable; the cookie and headers still apply.
      }
      document.documentElement.dataset.theme = prefTheme;
    },
    [locale, theme] as [string, string]
  );
  await scrubDomText(context, needles);
  try {
    const page = await context.newPage();
    // presence-studio keeps long-lived connections open (SSE/voice) and
    // never reaches 'networkidle'; 'load' + a short settle wait is the
    // pattern that works across all 5 surfaces.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // Wait until loading placeholders are gone (bounded: some panels poll
    // forever when a backend is offline), then settle for late layout.
    await page
      .waitForFunction(
        () => {
          const skeletons = document.querySelectorAll('.kb-skeleton, [aria-busy="true"]');
          return document.readyState === 'complete' && skeletons.length === 0;
        },
        undefined,
        { timeout: 12_000 }
      )
      .catch(() => undefined);
    await page.waitForTimeout(1_200);
    const fileName = `${spec.surface}-${spec.pageName}-${locale}-${theme}.png`;
    const filePath = `${outDir}/${fileName}`;
    const buffer = await page.screenshot({ fullPage: true, type: 'png' });
    safeWriteFile(filePath, buffer, { mkdir: true });
    return {
      surface: spec.surface,
      pageName: spec.pageName,
      theme,
      locale,
      status: 'ok',
      file: filePath,
    };
  } catch (error) {
    return {
      surface: spec.surface,
      pageName: spec.pageName,
      theme,
      locale,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await context.close();
  }
}

export const runCaptureSurfaceScreenshots = defineScript({
  name: 'capture:surface-screenshots',
  flags: [],
  async run(context) {
    const outDir = argument(context.argv, '--out');
    if (!outDir) throw new ScriptExitError(1, '--out <dir> is required');
    const themes = parseThemes(argument(context.argv, '--themes'));
    const locales = parseLocales(argument(context.argv, '--locales'));
    const surfaceFilter = argument(context.argv, '--surfaces')
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const width = Number(argument(context.argv, '--width') ?? '1440');
    const height = Number(argument(context.argv, '--height') ?? '900');
    const baseUrls = parseBaseUrlMap(argument(context.argv, '--base-url-map'));
    const needles = scrubNeedles(argument(context.argv, '--scrub'));

    const browser = await chromium.launch({ headless: true });
    const results: CaptureResult[] = [];
    try {
      for (const spec of pageSet(argument(context.argv, '--set'))) {
        const baseUrl = baseUrls[spec.surface];
        if (!baseUrl) continue;
        if (surfaceFilter && !surfaceFilter.includes(spec.surface)) continue;
        for (const locale of locales) {
          for (const theme of themes) {
            const result = await captureOne(
              browser,
              spec,
              baseUrl,
              theme,
              locale,
              width,
              height,
              outDir,
              needles
            );
            results.push(result);
            context.print(
              result.status === 'ok'
                ? `[ok] ${result.surface} ${result.pageName} ${locale} ${theme} -> ${result.file}`
                : `[FAILED] ${result.surface} ${result.pageName} ${locale} ${theme}: ${result.error}`
            );
          }
        }
      }
    } finally {
      await browser.close();
    }

    const failures = results.filter((r) => r.status === 'failed');
    context.print(`${results.length - failures.length}/${results.length} captures succeeded`);
    return { results, failures };
  },
});

if (
  isDirectScript(import.meta.url, 'capture_surface_screenshots.ts') ||
  isDirectScript(import.meta.url, 'capture_surface_screenshots.js')
)
  void runCaptureSurfaceScreenshots();
