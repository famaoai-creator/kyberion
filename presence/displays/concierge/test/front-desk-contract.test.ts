/* eslint-disable no-restricted-imports */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(appDir, relativePath), 'utf8');
}

describe('FD-00c/FD-01c front-desk contract (concierge)', () => {
  it('mounts the shared rail alongside the existing layout fixtures', () => {
    const layout = read('src/app/layout.tsx');
    expect(layout).toContain('FrontDeskRail');
    expect(layout).toContain('ConciergeHeader');
    expect(layout).toContain('ConversationDock');
    expect(layout).toContain('CommandPalette');
  });

  it('reads front-desk ports server-side in layout.tsx and passes them to CommandPalette, never hardcoded', () => {
    const layout = read('src/app/layout.tsx');
    const palette = read('src/app/command-palette.tsx');
    expect(layout).toContain('readFrontDeskSurfacePorts');
    expect(layout).toContain('frontDeskPorts={frontDeskPorts}');
    // The palette builds its 3 cross-surface hrefs from the prop, not a
    // hardcoded port literal (plan §2.6: "ポート番号をハードコードしない").
    expect(palette).not.toContain('3031');
    expect(palette).not.toContain('3050');
    expect(palette).toContain('frontDeskPorts');
  });

  it('drops the header nav links now that the rail carries them', () => {
    const header = read('src/app/concierge-header.tsx');
    expect(header).not.toContain('href="/ingest"');
    expect(header).not.toContain('href="/setup"');
    // The header still declares the surface identity contract.
    expect(header).toContain("t('header.tagline')");
    expect(header).toContain("locale === 'ja' ? '秘書室' : 'Concierge'");
  });

  it('renders the rail without target=_blank, raw loopback URLs, or emoji, and marks the current item', () => {
    const rail = read('src/app/front-desk-rail.tsx');
    expect(rail).not.toContain('target="_blank"');
    expect(rail).not.toContain("target={'_blank'}");
    expect(rail).not.toContain('127.0.0.1');
    // eslint-disable-next-line no-misleading-character-class
    expect(rail).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}]/u);
    expect(rail).toContain('aria-current');
    // 資料の取込 (ingest) stays reachable from the rail, labelled with the
    // existing header.ingest key, now that the header dropped its own link.
    expect(rail).toContain("t('header.ingest')");
  });

  it('guards /api/me and /api/front-desk/nav with the shared viewer resolver and no-store', () => {
    const me = read('src/app/api/me/route.ts');
    const nav = read('src/app/api/front-desk/nav/route.ts');
    for (const route of [me, nav]) {
      expect(route).toContain('resolveConciergeViewer');
      expect(route).toMatch(/resolved\.response/);
      expect(route).toContain('no-store');
    }
    // The tenant query param may only narrow — it is passed through as
    // `requestedTenant`, never used to widen the server-resolved scope.
    expect(me).toContain("searchParams.get('tenant')");
    expect(me).toContain('requestedTenant');
    expect(me).not.toContain('tenantSlugs: ');
  });

  it('redirects the interim /settings route to /setup', () => {
    const settings = read('src/app/settings/page.tsx');
    expect(settings).toContain("redirect('/setup')");
  });
});

describe('FD-00c buildFrontDeskNavPayload (unit)', () => {
  it('returns 5 rail items with ja labels, relative concierge hrefs, and absolute presence-studio hrefs', async () => {
    vi.resetModules();
    vi.doMock('@agent/core/front-desk-nav', async () => {
      const actual = await vi.importActual<typeof import('@agent/core/front-desk-nav')>(
        '@agent/core/front-desk-nav'
      );
      return {
        ...actual,
        readFrontDeskSurfacePorts: () => ({ 'presence-studio': 4031, concierge: 4050 }),
      };
    });

    const { buildFrontDeskNavPayload } = await import('../src/lib/front-desk-nav');
    const payload = buildFrontDeskNavPayload({ locale: 'ja', role: 'owner' });

    expect(payload.ok).toBe(true);
    expect(payload.current_surface).toBe('concierge');
    expect(payload.items).toHaveLength(5);
    expect(payload.items.map((item) => item.id)).toEqual([
      'home',
      'ask',
      'decide',
      'progress',
      'settings',
    ]);

    const byId = Object.fromEntries(payload.items.map((item) => [item.id, item]));
    expect(byId.home.label).toBe('ホーム');
    expect(byId.decide.label).toBe('決める');

    // decide/settings are hosted on concierge itself: relative, not external.
    expect(byId.decide.external).toBe(false);
    expect(byId.decide.href).toBe('/');
    expect(byId.settings.external).toBe(false);
    expect(byId.settings.href).toBe('/settings');

    // home/ask/progress are hosted on presence-studio: absolute, same-tab.
    for (const id of ['home', 'ask', 'progress'] as const) {
      expect(byId[id].external).toBe(true);
      expect(byId[id].href).toBe(`http://127.0.0.1:4031${byId[id].id === 'home' ? '/' : `/${id}`}`);
    }

    vi.doUnmock('@agent/core/front-desk-nav');
  });
});
