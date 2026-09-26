/**
 * Kyberion Browser Inspector CLI
 *
 * Lightweight single-command page discovery and DOM analysis.
 * Dumps form controls, buttons, headings, links, and structure from any URL
 * without requiring hand-authored ADF files.
 *
 * Usage:
 *   pnpm kyberion browser inspect <url> [--mode browser|fetch] [--headed] [--json]
 */

import http from 'node:http';
import { createStandardYargs } from '@agent/core/cli-utils';
import { htmlToMarkdown, extractHtmlTitle } from '@agent/core/html-to-markdown';
import {
  assertSupportedNodeEngine,
  loadBrowserActuator,
  type BrowserActuatorHandle,
} from './browser_playwright_executor.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { withExecutionContextAsync } from '@agent/core/authority';

export interface PageInspectionResult {
  mode: 'browser' | 'fetch' | 'cdp' | 'extension';
  url: string;
  title: string;
  headings: Array<{ level: string; text: string }>;
  inputs: Array<{
    tag: string;
    type?: string;
    name?: string;
    id?: string;
    placeholder?: string;
    value?: string;
    label?: string;
    required?: boolean;
  }>;
  buttons: Array<{
    text: string;
    id?: string;
    className?: string;
    disabled?: boolean;
  }>;
  links: Array<{
    text: string;
    href: string;
  }>;
  textExcerpt: string;
  screenshotPath?: string;
}

export interface InspectBrowserPageDeps {
  loadActuator?: () => Promise<BrowserActuatorHandle>;
  fetchFn?: typeof fetch;
  nodeVersion?: string;
  waitForExtensionInspection?: (options: {
    port: number;
    timeoutMs: number;
  }) => Promise<PageInspectionResult>;
}

export function formatHumanReport(res: PageInspectionResult): string {
  const lines: string[] = [];
  lines.push(`🌐 Page: ${res.title || '(No Title)'}`);
  lines.push(`📍 URL: ${res.url}`);
  lines.push(`⚡ Mode: ${res.mode}`);
  if (res.screenshotPath) {
    lines.push(`📸 Screenshot: ${res.screenshotPath}`);
  }
  lines.push('');

  if (res.headings.length > 0) {
    lines.push(`📑 Headings (${res.headings.length}):`);
    for (const h of res.headings) {
      lines.push(`   [${h.level.toUpperCase()}] ${h.text}`);
    }
    lines.push('');
  }

  if (res.inputs.length > 0) {
    lines.push(`📝 Form Controls & Inputs (${res.inputs.length}):`);
    for (const inp of res.inputs) {
      const parts = [`[${inp.tag}${inp.type ? `:${inp.type}` : ''}]`];
      if (inp.name) parts.push(`name="${inp.name}"`);
      if (inp.id) parts.push(`#${inp.id}`);
      if (inp.placeholder) parts.push(`placeholder="${inp.placeholder}"`);
      if (inp.label) parts.push(`label="${inp.label}"`);
      if (inp.required) parts.push('(required)');
      lines.push(`   - ${parts.join(' ')}`);
    }
    lines.push('');
  }

  if (res.buttons.length > 0) {
    lines.push(`🔘 Action Buttons (${res.buttons.length}):`);
    for (const btn of res.buttons) {
      const meta = [btn.id ? `#${btn.id}` : '', btn.disabled ? '(disabled)' : '']
        .filter(Boolean)
        .join(' ');
      lines.push(`   - "${btn.text}" ${meta}`.trim());
    }
    lines.push('');
  }

  if (res.links.length > 0) {
    lines.push(`🔗 Key Links (${res.links.length}):`);
    for (const l of res.links.slice(0, 15)) {
      lines.push(`   - "${l.text}" -> ${l.href}`);
    }
    lines.push('');
  }

  if (res.textExcerpt) {
    lines.push('📄 Text Preview:');
    lines.push(`   ${res.textExcerpt.slice(0, 200)}...`);
  }

  return lines.join('\n');
}

export async function inspectWithFetch(
  url: string,
  fetchFn: typeof fetch = fetch
): Promise<PageInspectionResult> {
  const resp = await fetchFn(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    },
  });

  const html = await resp.text();
  const title = extractHtmlTitle(html) ?? '';

  // Parse basic form elements
  const inputMatches = html.matchAll(/<(input|select|textarea)([^>]+)>/gi);
  const inputs: PageInspectionResult['inputs'] = [];
  for (const match of inputMatches) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    const nameMatch = attrs.match(/name=["']([^"']+)["']/i);
    const typeMatch = attrs.match(/type=["']([^"']+)["']/i);
    const idMatch = attrs.match(/id=["']([^"']+)["']/i);
    const phMatch = attrs.match(/placeholder=["']([^"']+)["']/i);
    const reqMatch = /\brequired\b/i.test(attrs);
    inputs.push({
      tag,
      type: typeMatch ? typeMatch[1] : undefined,
      name: nameMatch ? nameMatch[1] : undefined,
      id: idMatch ? idMatch[1] : undefined,
      placeholder: phMatch ? phMatch[1] : undefined,
      required: reqMatch,
    });
  }

  // Parse buttons
  const buttonMatches = html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/gi);
  const buttons: PageInspectionResult['buttons'] = [];
  for (const match of buttonMatches) {
    let text = match[1];
    while (/<[^>]*>/g.test(text)) {
      text = text.replace(/<[^>]*>/g, '');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text) buttons.push({ text: text.slice(0, 50) });
  }

  // Parse headings
  const headingMatches = html.matchAll(/<(h[1-3])[^>]*>([\s\S]*?)<\/\1>/gi);
  const headings: PageInspectionResult['headings'] = [];
  for (const match of headingMatches) {
    const level = match[1].toLowerCase();
    let text = match[2];
    while (/<[^>]*>/g.test(text)) {
      text = text.replace(/<[^>]*>/g, '');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (text) headings.push({ level, text: text.slice(0, 80) });
  }

  // Parse links
  const linkMatches = html.matchAll(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi);
  const links: PageInspectionResult['links'] = [];
  for (const match of linkMatches) {
    const href = match[1].trim();
    let text = match[2];
    while (/<[^>]*>/g.test(text)) {
      text = text.replace(/<[^>]*>/g, '');
    }
    text = text.replace(/\s+/g, ' ').trim();
    const isSafeScheme =
      href.startsWith('/') ||
      href.startsWith('./') ||
      href.startsWith('../') ||
      /^https?:\/\//i.test(href);
    if (text && isSafeScheme) {
      links.push({ text: text.slice(0, 50), href });
    }
  }

  const plainText = htmlToMarkdown(html).replace(/\s+/g, ' ').trim();

  return {
    mode: 'fetch',
    url,
    title,
    headings: headings.slice(0, 15),
    inputs: inputs.slice(0, 20),
    buttons: buttons.slice(0, 20),
    links: links.slice(0, 20),
    textExcerpt: plainText.slice(0, 400),
  };
}

export async function inspectWithBrowser(
  url: string,
  options: {
    waitMs: number;
    headed: boolean;
    screenshotPath?: string;
  },
  deps: InspectBrowserPageDeps = {}
): Promise<PageInspectionResult> {
  const actuator = await (deps.loadActuator ?? loadBrowserActuator)();
  const pipeline = {
    action: 'pipeline',
    session_id: `browser-inspect-${Date.now().toString(36)}`,
    options: {
      headless: !options.headed,
      keep_alive: false,
    },
    steps: [
      {
        type: 'capture',
        op: 'goto',
        params: { url, waitUntil: 'domcontentloaded' },
      },
      ...(options.waitMs > 0
        ? [{ type: 'apply', op: 'wait', params: { ms: options.waitMs } }]
        : []),
      ...(options.screenshotPath
        ? [
            {
              type: 'capture',
              op: 'screenshot',
              params: { path: options.screenshotPath, fullPage: false },
            },
          ]
        : []),
      {
        type: 'capture',
        op: 'evaluate',
        params: {
          export_as: 'page_analysis',
          script: `(() => {
            const title = document.title || '';
            const finalUrl = window.location.href;
            
            const inputs = Array.from(document.querySelectorAll('input, select, textarea, button[type=\"submit\"]')).map(el => ({
              tag: el.tagName.toLowerCase(),
              type: el.type || undefined,
              name: el.name || undefined,
              id: el.id || undefined,
              placeholder: el.placeholder || undefined,
              label: (el.labels && el.labels[0] ? el.labels[0].innerText.trim() : '') || el.getAttribute('aria-label') || undefined,
              required: el.required || undefined
            })).filter(x => x.name || x.id || x.placeholder || x.label).slice(0, 25);
            
            const buttons = Array.from(document.querySelectorAll('button, [role=\"button\"], a.btn, a[class*=\"button\"]')).map(el => ({
              text: (el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim(),
              id: el.id || undefined,
              className: el.className ? String(el.className).slice(0, 40) : undefined,
              disabled: Boolean(el.disabled)
            })).filter(x => x.text && x.text.length < 60).slice(0, 25);
            
            const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(el => ({
              level: el.tagName.toLowerCase(),
              text: (el.innerText || '').replace(/\\s+/g, ' ').trim()
            })).filter(x => x.text).slice(0, 15);
            
            const links = Array.from(document.querySelectorAll('a[href]')).map(el => ({
              text: (el.innerText || '').replace(/\\s+/g, ' ').trim(),
              href: el.href
            })).filter(x => {
              if (!x.text || x.text.length >= 50) return false;
              const h = String(x.href || '').trim();
              return h.startsWith('/') || h.startsWith('./') || h.startsWith('../') || /^https?:\\/\\//i.test(h);
            }).slice(0, 20);
            
            const textExcerpt = (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 400);
            
            return { title, url: finalUrl, inputs, buttons, headings, links, textExcerpt };
          })()`,
        },
      },
    ],
  };

  const raw = await withExecutionContextAsync('surface_runtime', () =>
    actuator.handleAction(pipeline)
  );
  const resContext = (raw.context as Record<string, unknown> | undefined) || {};
  const analysis = (resContext.page_analysis as Record<string, unknown> | undefined) || {};

  return {
    mode: 'browser',
    url: String(analysis.url || url),
    title: String(analysis.title || ''),
    headings: (analysis.headings as PageInspectionResult['headings']) || [],
    inputs: (analysis.inputs as PageInspectionResult['inputs']) || [],
    buttons: (analysis.buttons as PageInspectionResult['buttons']) || [],
    links: (analysis.links as PageInspectionResult['links']) || [],
    textExcerpt: String(analysis.textExcerpt || ''),
    screenshotPath: options.screenshotPath,
  };
}

export async function inspectWithCdp(
  url: string,
  options: {
    cdpPort?: number;
    cdpUrl?: string;
    waitMs: number;
    screenshotPath?: string;
  },
  deps: InspectBrowserPageDeps = {}
): Promise<PageInspectionResult> {
  const actuator = await (deps.loadActuator ?? loadBrowserActuator)();
  const pipeline = {
    action: 'pipeline',
    session_id: `browser-inspect-cdp-${Date.now().toString(36)}`,
    options: {
      connect_over_cdp: true,
      cdp_port: options.cdpPort || 9222,
      cdp_url: options.cdpUrl,
      keep_alive: false,
    },
    steps: [
      ...(url
        ? [
            {
              type: 'capture',
              op: 'goto',
              params: { url, waitUntil: 'domcontentloaded' },
            },
          ]
        : []),
      ...(options.waitMs > 0
        ? [{ type: 'apply', op: 'wait', params: { ms: options.waitMs } }]
        : []),
      ...(options.screenshotPath
        ? [
            {
              type: 'capture',
              op: 'screenshot',
              params: { path: options.screenshotPath, fullPage: false },
            },
          ]
        : []),
      {
        type: 'capture',
        op: 'evaluate',
        params: {
          export_as: 'page_analysis',
          script: `(() => {
            const title = document.title || '';
            const finalUrl = window.location.href;
            
            const inputs = Array.from(document.querySelectorAll('input, select, textarea, button[type=\"submit\"]')).map(el => ({
              tag: el.tagName.toLowerCase(),
              type: el.type || undefined,
              name: el.name || undefined,
              id: el.id || undefined,
              placeholder: el.placeholder || undefined,
              label: (el.labels && el.labels[0] ? el.labels[0].innerText.trim() : '') || el.getAttribute('aria-label') || undefined,
              required: el.required || undefined
            })).filter(x => x.name || x.id || x.placeholder || x.label).slice(0, 30);
            
            const buttons = Array.from(document.querySelectorAll('button, [role=\"button\"], a.btn, a[class*=\"button\"]')).map(el => ({
              text: (el.innerText || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim(),
              id: el.id || undefined,
              className: el.className ? String(el.className).slice(0, 40) : undefined,
              disabled: Boolean(el.disabled)
            })).filter(x => x.text && x.text.length < 60).slice(0, 30);
            
            const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(el => ({
              level: el.tagName.toLowerCase(),
              text: (el.innerText || '').replace(/\\s+/g, ' ').trim()
            })).filter(x => x.text).slice(0, 20);
            
            const links = Array.from(document.querySelectorAll('a[href]')).map(el => ({
              text: (el.innerText || '').replace(/\\s+/g, ' ').trim(),
              href: el.href
            })).filter(x => {
              if (!x.text || x.text.length >= 50) return false;
              const h = String(x.href || '').trim();
              return h.startsWith('/') || h.startsWith('./') || h.startsWith('../') || /^https?:\\/\\//i.test(h);
            }).slice(0, 25);
            
            const textExcerpt = (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 500);
            
            return { title, url: finalUrl, inputs, buttons, headings, links, textExcerpt };
          })()`,
        },
      },
    ],
  };

  const raw = await withExecutionContextAsync('surface_runtime', () =>
    actuator.handleAction(pipeline)
  );
  const resContext = (raw.context as Record<string, unknown> | undefined) || {};
  const analysis = (resContext.page_analysis as Record<string, unknown> | undefined) || {};

  return {
    mode: 'cdp',
    url: String(analysis.url || url),
    title: String(analysis.title || ''),
    headings: (analysis.headings as PageInspectionResult['headings']) || [],
    inputs: (analysis.inputs as PageInspectionResult['inputs']) || [],
    buttons: (analysis.buttons as PageInspectionResult['buttons']) || [],
    links: (analysis.links as PageInspectionResult['links']) || [],
    textExcerpt: String(analysis.textExcerpt || ''),
    screenshotPath: options.screenshotPath,
  };
}

export function defaultWaitForExtensionInspection(options: {
  port: number;
  timeoutMs: number;
  print?: (msg: string) => void;
}): Promise<PageInspectionResult> {
  const { port, timeoutMs, print = console.error } = options;
  return new Promise((resolve, reject) => {
    let resolved = false;
    let timer: NodeJS.Timeout | null = null;

    const server = http.createServer((req, res) => {
      // Enable CORS for Chrome Extension requests
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'POST' && req.url === '/inspection') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          try {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            const data = JSON.parse(rawBody) as PageInspectionResult;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));

            if (!resolved) {
              resolved = true;
              if (timer) clearTimeout(timer);
              server.close();
              resolve({
                ...data,
                mode: 'extension',
              });
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid inspection payload' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(port, '127.0.0.1', () => {
      print(
        `📡 [EXTENSION MODE] Listening on http://127.0.0.1:${port}/inspection\n` +
          `   1. Open Chrome with target page (e.g. JAL / ANA)\n` +
          `   2. Click Kyberion Browser Bridge icon -> Open Side Panel\n` +
          // i18n-exempt: Chrome Extension button label literal for operator guidance
          `   3. Go to "Live" tab -> Click "このタブを接続"\n` +
          // i18n-exempt: Chrome Extension button labels literal for operator guidance
          `   4. In "PAGE DISCOVERY & INSPECTION" -> Click "ページ構造を解析" -> Click "Kyberion CLIへ送信"\n` +
          `   (Note: If port is changed, ensure Port field matches ${port})`
      );
    });

    server.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        if (timer) clearTimeout(timer);
        reject(err);
      }
    });

    timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        server.close();
        reject(new Error(`Extension inspection timed out after ${Math.round(timeoutMs / 1000)}s`));
      }
    }, timeoutMs);
  });
}

export async function inspectWithExtension(
  options: {
    port?: number;
    timeoutMs?: number;
  },
  deps: InspectBrowserPageDeps = {}
): Promise<PageInspectionResult> {
  const port = options.port || 8788;
  const timeoutMs = options.timeoutMs || 60_000;
  const waiter = deps.waitForExtensionInspection ?? defaultWaitForExtensionInspection;
  return waiter({ port, timeoutMs });
}

export async function main(
  rawArgs: string[] = [],
  print: (value: unknown) => void = console.log,
  deps: InspectBrowserPageDeps = {}
): Promise<PageInspectionResult> {
  const normalizedArgs = rawArgs.filter((arg) => arg !== '--');
  const argv = await createStandardYargs(['node', 'inspect_browser_page', ...normalizedArgs])
    .usage('$0 [url] [options]')
    .positional('url', {
      type: 'string',
      description: 'Target URL to inspect (optional in extension/cdp mode)',
    })
    .option('mode', {
      type: 'string',
      choices: ['browser', 'fetch', 'cdp', 'extension'],
      default: 'browser',
      description:
        'Inspection engine: browser (Playwright), fetch (fast HTML), cdp (existing Chrome), extension (Chrome Extension bridge)',
    })
    .option('cdp-port', {
      type: 'number',
      default: 9222,
      description: 'Chrome remote debugging port for cdp mode',
    })
    .option('cdp-url', {
      type: 'string',
      description: 'Optional explicit Chrome CDP URL (e.g. http://127.0.0.1:9222)',
    })
    .option('extension-port', {
      type: 'number',
      default: 8788,
      description: 'Local loopback port to receive extension inspection payload',
    })
    .option('wait', {
      type: 'number',
      default: 2500,
      description: 'Milliseconds to wait for dynamic hydration in browser/cdp mode',
    })
    .option('timeout', {
      type: 'number',
      default: 60000,
      description: 'Milliseconds to wait for extension inspection payload in extension mode',
    })
    .option('headed', {
      type: 'boolean',
      default: false,
      description: 'Launch visible browser window (Playwright mode)',
    })
    .option('screenshot', {
      type: 'string',
      description: 'Optional path to save page screenshot (browser/cdp mode)',
    })
    .option('json', {
      type: 'boolean',
      default: false,
      description: 'Output pure structured JSON',
    })
    .parse();

  const targetUrl = argv.url || (typeof argv._[0] === 'string' ? argv._[0] : '');
  const mode = (
    ['browser', 'fetch', 'cdp', 'extension'].includes(String(argv.mode)) ? argv.mode : 'browser'
  ) as PageInspectionResult['mode'];

  if (!targetUrl && (mode === 'browser' || mode === 'fetch')) {
    throw new ScriptExitError(
      1,
      'Target URL is required for browser and fetch modes: pnpm kyberion browser inspect <url>'
    );
  }

  assertSupportedNodeEngine(deps.nodeVersion ?? process.version);

  let report: PageInspectionResult;

  if (mode === 'fetch') {
    report = await inspectWithFetch(targetUrl, deps.fetchFn);
  } else if (mode === 'extension') {
    report = await inspectWithExtension(
      {
        port: Number(argv['extension-port'] || 8788),
        timeoutMs: Number(argv.timeout || 60000),
      },
      deps
    );
  } else if (mode === 'cdp') {
    report = await inspectWithCdp(
      targetUrl,
      {
        cdpPort: Number(argv['cdp-port'] || 9222),
        cdpUrl: argv['cdp-url'] ? String(argv['cdp-url']) : undefined,
        waitMs: argv.wait,
        screenshotPath: argv.screenshot ? String(argv.screenshot) : undefined,
      },
      deps
    );
  } else {
    report = await inspectWithBrowser(
      targetUrl,
      {
        waitMs: argv.wait,
        headed: Boolean(argv.headed),
        screenshotPath: argv.screenshot ? String(argv.screenshot) : undefined,
      },
      deps
    );
  }

  if (argv.json) {
    print(JSON.stringify(report, null, 2));
  } else {
    print(formatHumanReport(report));
  }

  return report;
}

export const inspectBrowserPage = defineScript({
  name: 'browser-inspect',
  flags: ['json', 'quiet'],
  async run(context) {
    await main(context.argv, context.print);
  },
});

if (
  isDirectScript(import.meta.url, 'inspect_browser_page.ts') ||
  isDirectScript(import.meta.url, 'inspect_browser_page.js')
) {
  void inspectBrowserPage();
}
