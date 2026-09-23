import { describe, expect, it } from 'vitest';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { PAD_UI_ROUTES, resolvePadLocale } from '../lib/pad-ui.js';
import {
  MEETING_NOTEPAD_CLIENT_SCRIPT,
  MEETING_NOTEPAD_TEXT_KEYS,
  meetingNotepadPageHtml,
} from './notepad-page.js';

const KANA = /[぀-ヿ]/u;
const NATIVE_DIALOG = /(?<![\w.$])(?:window\.)?(?:confirm|prompt|alert)\s*\(/u;

function page(url: string) {
  return meetingNotepadPageHtml({
    token: 'tok-123',
    exportUrl: '/export',
    minutesUrl: '/minutes',
    transcribeUrl: '/transcribe',
    defaultInstruction: 'Summarize',
    defaultTitle: 'Weekly',
    outLabel: 'active/shared/tmp/meeting-notepad',
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

describe('meeting notepad page (shared A2UI kit)', () => {
  it('renders English for ?lang=en with no Japanese text', () => {
    const html = page('/?lang=en');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('Meeting Notepad (local only)');
    const bootstrap = bootstrapOf(html);
    expect(bootstrap.locale).toBe('en');
    expect(bootstrap.language).toBe('en');
    for (const text of Object.values(bootstrap.texts as Record<string, string>)) {
      expect(text).not.toMatch(KANA);
    }
    expect(html.replace(/<script[\s\S]*?<\/script>/gu, '')).not.toMatch(KANA);
  });

  it('renders Japanese by default for a ja operator', () => {
    const html = page('/');
    expect(html).toContain('<html lang="ja">');
    const bootstrap = bootstrapOf(html);
    expect(bootstrap.texts['meeting_notepad:handoff']).toBe('Kyberionへ渡す');
    expect(bootstrap.language).toBe('ja');
  });

  it('embeds the server contract and every client text in the bootstrap', () => {
    const bootstrap = bootstrapOf(page('/?lang=en'));
    expect(bootstrap).toMatchObject({
      token: 'tok-123',
      exportUrl: '/export',
      minutesUrl: '/minutes',
      transcribeUrl: '/transcribe',
      defaultInstruction: 'Summarize',
      defaultTitle: 'Weekly',
      outLabel: 'active/shared/tmp/meeting-notepad',
    });
    for (const key of MEETING_NOTEPAD_TEXT_KEYS) {
      expect(bootstrap.texts[key], key).toBeTruthy();
      expect(bootstrap.texts[key], key).not.toBe(key);
    }
  });

  it('uses the kit stylesheets and client, not native dialogs', () => {
    const html = page('/?lang=en');
    expect(html).toContain(`href="${PAD_UI_ROUTES.tokens}"`);
    expect(html).toContain(`href="${PAD_UI_ROUTES.stylesheet}"`);
    expect(html).toContain(PAD_UI_ROUTES.client);
    expect(html).toContain('data-pad-display-controls');
    expect(html).not.toMatch(NATIVE_DIALOG);
    expect(html).not.toContain('<style>');
  });

  it('keeps the browser module on the kit (voice, file drop, camera, dialog) and the X-MN-Token header', () => {
    const source = readTextFile(pathResolver.rootResolve(MEETING_NOTEPAD_CLIENT_SCRIPT));
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gmu)].map((m) => m[1]);
    expect(imports).toEqual([PAD_UI_ROUTES.client]);
    for (const type of [
      'ui:toolbar',
      'ui:voice-input',
      'ui:voice-state',
      'ui:file-drop',
      'ui:camera-capture',
      'ui:dialog',
      'ui:code',
    ]) {
      expect(source).toContain(`'${type}'`);
    }
    expect(source).toContain("mode: 'record'");
    expect(source).toContain('chunk_ms: 5000');
    expect(source).toContain("'X-MN-Token'");
    expect(source).toContain("'meeting-notepad.draft.v1'");
    expect(source).not.toMatch(KANA);
  });

  it('serves the kit assets before its own routes and renders per request locale', () => {
    const source = readTextFile(pathResolver.rootResolve('scripts/meeting-notepad/server.ts'));
    const assets = source.indexOf('if (handlePadUiAsset(req, res)) return;');
    expect(assets).toBeGreaterThan(-1);
    expect(assets).toBeLessThan(source.indexOf("pathname === '/index.html'"));
    expect(source).toContain('locale: resolvePadLocale(req)');
    expect(source).toContain(
      "(req.url === '/export' || req.url === '/minutes' || req.url === '/transcribe')"
    );
    expect(source).toContain("req.headers['x-mn-token'] !== TOKEN");
  });
});
