import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { PAD_UI_ROUTES, resolvePadLocale } from '../lib/pad-ui.js';
import {
  MEMORY_CAPTURE_CLIENT_SCRIPT,
  MEMORY_CAPTURE_TEXT_KEYS,
  memoryCapturePageHtml,
} from './page.js';
import { padBootstrapOf } from '../lib/pad-ui.test-support.js';

const KANA = /[぀-ヿ]/u;
const NATIVE_DIALOG = /(?<![\w.$])(?:window\.)?(?:confirm|prompt|alert)\s*\(/u;

function page(url: string) {
  return memoryCapturePageHtml({
    token: 'tok-123',
    exportUrl: '/export',
    defaultInstruction: 'Sort it',
    outLabel: 'active/shared/tmp/memory-capture',
    locale: resolvePadLocale({ url, headers: {} }, () => 'ja'),
  });
}

describe('memory capture page (shared A2UI kit)', () => {
  it('renders English for ?lang=en with no Japanese text', () => {
    const html = page('/?lang=en');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Memory Capture');
    const bootstrap = padBootstrapOf(html);
    expect(bootstrap.locale).toBe('en');
    for (const text of Object.values(bootstrap.texts as Record<string, string>)) {
      expect(text).not.toMatch(KANA);
    }
    expect(html.replace(/<script[\s\S]*?<\/script>/gu, '')).not.toMatch(KANA);
  });

  it('renders Japanese by default for a ja operator', () => {
    const html = page('/');
    expect(html).toContain('<html lang="ja">');
    expect(padBootstrapOf(html).texts['memory_capture:handoff']).toBe('Kyberionへ渡す');
  });

  it('embeds the server contract and every client text in the bootstrap', () => {
    const bootstrap = padBootstrapOf(page('/?lang=en'));
    expect(bootstrap).toMatchObject({
      token: 'tok-123',
      exportUrl: '/export',
      defaultInstruction: 'Sort it',
    });
    for (const key of MEMORY_CAPTURE_TEXT_KEYS) {
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

  it('keeps the browser module on the kit and the X-MC-Token header', () => {
    const source = readTextFile(pathResolver.rootResolve(MEMORY_CAPTURE_CLIENT_SCRIPT));
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gmu)].map((m) => m[1]);
    expect(imports).toEqual([PAD_UI_ROUTES.client]);
    for (const type of ['ui:toolbar', 'ui:textarea', 'ui:voice-input', 'ui:select', 'ui:dialog']) {
      expect(source).toContain(`'${type}'`);
    }
    expect(source).toContain("'X-MC-Token'");
    expect(source).not.toMatch(KANA);
  });

  it('serves the kit assets before its own routes and renders per request locale', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/memory-capture/server.ts'));
    const assets = source.indexOf('if (handlePadUiAsset(req, res)) return;');
    expect(assets).toBeGreaterThan(-1);
    expect(assets).toBeLessThan(source.indexOf("pathname === '/index.html'"));
    expect(source).toContain('resolvePadLocale(req)');
    expect(source).toContain("req.method === 'POST' && req.url === '/export'");
  });
});
