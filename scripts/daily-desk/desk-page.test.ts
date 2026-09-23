import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { PAD_UI_ROUTES, resolvePadLocale } from '../lib/pad-ui.js';
import { DAILY_DESK_CLIENT_SCRIPT, DAILY_DESK_TEXT_KEYS, dailyDeskPageHtml } from './desk-page.js';
import { padBootstrapOf, withoutScriptBlocks } from '../lib/pad-ui.test-support.js';

const KANA = /[぀-ヿ]/u;
const NATIVE_DIALOG = /(?<![\w.$])(?:window\.)?(?:confirm|prompt|alert)\s*\(/u;

function page(url: string) {
  return dailyDeskPageHtml({
    token: 'tok-123',
    exportUrl: '/export',
    loadUrl: '/load',
    outLabel: 'active/shared/tmp/daily-desk',
    journal: 'j',
    todo: 't',
    now: 'n',
    periodKey: '2026-09-24',
    facePaths: { journal: null, todo: null, now: null },
    locale: resolvePadLocale({ url, headers: {} }, () => 'ja'),
  });
}

describe('daily desk page (shared A2UI kit)', () => {
  it('renders English for ?lang=en with no Japanese text', () => {
    const html = page('/?lang=en');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Daily Desk (local only)');
    const bootstrap = padBootstrapOf(html);
    expect(bootstrap.locale).toBe('en');
    for (const text of Object.values(bootstrap.texts as Record<string, string>)) {
      expect(text).not.toMatch(KANA);
    }
    expect(withoutScriptBlocks(html)).not.toMatch(KANA);
  });

  it('renders Japanese by default for a ja operator', () => {
    const html = page('/');
    expect(html).toContain('<html lang="ja">');
    expect(padBootstrapOf(html).texts['daily_desk:load_disk']).toBe('ディスクから再読込');
  });

  it('embeds the server contract and every client text in the bootstrap', () => {
    const bootstrap = padBootstrapOf(page('/?lang=en'));
    expect(bootstrap).toMatchObject({
      token: 'tok-123',
      exportUrl: '/export',
      loadUrl: '/load',
      periodKey: '2026-09-24',
      faces: { journal: 'j', todo: 't', now: 'n' },
    });
    for (const key of DAILY_DESK_TEXT_KEYS) {
      expect(bootstrap.texts[key], key).toBeTruthy();
      expect(bootstrap.texts[key], key).not.toBe(key);
    }
  });

  it('uses the kit stylesheets and client, not native dialogs', () => {
    const html = page('/?lang=en');
    expect(html).toContain(`href="${PAD_UI_ROUTES.tokens}"`);
    expect(html).toContain(`href="${PAD_UI_ROUTES.stylesheet}"`);
    expect(html).toContain('data-pad-display-controls');
    expect(html).not.toMatch(NATIVE_DIALOG);
    expect(html).not.toContain('<style>');
  });

  it('keeps the browser module on the kit and the X-DD-Token header', () => {
    const source = readTextFile(pathResolver.rootResolve(DAILY_DESK_CLIENT_SCRIPT));
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gmu)].map((m) => m[1]);
    expect(imports).toEqual([PAD_UI_ROUTES.client]);
    for (const type of ['ui:toolbar', 'ui:callout', 'ui:grid', 'ui:textarea', 'ui:dialog']) {
      expect(source).toContain(`'${type}'`);
    }
    expect(source).toContain("'X-DD-Token'");
    expect(source).not.toMatch(KANA);
  });

  it('serves the kit assets before its own routes and renders per request locale', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/daily-desk/server.ts'));
    const assets = source.indexOf('if (handlePadUiAsset(req, res)) return;');
    expect(assets).toBeGreaterThan(-1);
    expect(assets).toBeLessThan(source.indexOf("pathname === '/index.html'"));
    expect(source).toContain('resolvePadLocale(req)');
    expect(source).toContain("(req.url === '/export' || req.url === '/load')");
  });
});
