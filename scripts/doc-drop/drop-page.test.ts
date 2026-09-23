import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { PAD_UI_ROUTES, resolvePadLocale } from '../lib/pad-ui.js';
import {
  DOC_DROP_ACCEPT,
  DOC_DROP_CLIENT_SCRIPT,
  DOC_DROP_TEXT_KEYS,
  docDropPageHtml,
} from './drop-page.js';

const KANA = /[぀-ヿ]/u;
const NATIVE_DIALOG = /(?<![\w.$])(?:window\.)?(?:confirm|prompt|alert)\s*\(/u;

function page(url: string) {
  return docDropPageHtml({
    token: 'tok-123',
    exportUrl: '/export',
    defaultInstruction: 'Parse it',
    outLabel: 'active/shared/tmp/doc-drop',
    maxFileBytes: 12 * 1024 * 1024,
    locale: resolvePadLocale({ url, headers: {} }, () => 'ja'),
  });
}

function bootstrapOf(html: string): Record<string, any> {
  const match = /<script type="application\/json" id="pad-bootstrap">([\s\S]*?)<\/script>/u.exec(
    html
  );
  expect(match).not.toBeNull();
  return JSON.parse(match![1]);
}

describe('doc drop page (shared A2UI kit)', () => {
  it('renders English for ?lang=en with no Japanese text', () => {
    const html = page('/?lang=en');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Doc Drop (local only)');
    const bootstrap = bootstrapOf(html);
    expect(bootstrap.locale).toBe('en');
    for (const text of Object.values(bootstrap.texts as Record<string, string>)) {
      expect(text).not.toMatch(KANA);
    }
    expect(html.replace(/<script[\s\S]*?<\/script>/gu, '')).not.toMatch(KANA);
  });

  it('renders Japanese by default for a ja operator', () => {
    const html = page('/');
    expect(html).toContain('<html lang="ja">');
    expect(bootstrapOf(html).texts['doc_drop:clear']).toBe('クリア');
  });

  it('embeds the server contract and every client text in the bootstrap', () => {
    const bootstrap = bootstrapOf(page('/?lang=en'));
    expect(bootstrap).toMatchObject({
      token: 'tok-123',
      exportUrl: '/export',
      accept: DOC_DROP_ACCEPT,
      maxFileBytes: 12 * 1024 * 1024,
    });
    for (const key of DOC_DROP_TEXT_KEYS) {
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

  it('keeps the browser module on the kit and the X-DDROP-Token header', () => {
    const source = readTextFile(pathResolver.rootResolve(DOC_DROP_CLIENT_SCRIPT));
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gmu)].map((m) => m[1]);
    expect(imports).toEqual([PAD_UI_ROUTES.client]);
    for (const type of [
      'ui:toolbar',
      'ui:file-drop',
      'ui:camera-capture',
      'ui:textarea',
      'ui:dialog',
    ]) {
      expect(source).toContain(`'${type}'`);
    }
    expect(source).toContain("'X-DDROP-Token'");
    expect(source).not.toMatch(KANA);
  });

  it('serves the kit assets before its own routes and renders per request locale', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/doc-drop/server.ts'));
    const assets = source.indexOf('if (handlePadUiAsset(req, res)) return;');
    expect(assets).toBeGreaterThan(-1);
    expect(assets).toBeLessThan(source.indexOf("pathname === '/index.html'"));
    expect(source).toContain('resolvePadLocale(req)');
    expect(source).toContain('maxFileBytes: DOC_DROP_MAX_FILE_BYTES');
    expect(source).toContain("req.method === 'POST' && req.url === '/export'");
  });
});
