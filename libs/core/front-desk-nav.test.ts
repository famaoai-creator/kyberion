import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadSurfaceManifestMock = vi.hoisted(() => vi.fn());
const healthFetchMock = vi.hoisted(() => vi.fn());
const resolveBrowserUrlMock = vi.hoisted(() => vi.fn());
vi.mock('./surface/surface-url.js', () => ({ resolveSurfaceBrowserUrl: resolveBrowserUrlMock }));

vi.mock('./surface/surface-runtime.js', () => ({
  loadSurfaceManifest: loadSurfaceManifestMock,
}));

import {
  DEFAULT_FRONT_DESK_PORTS,
  FRONT_DESK_HELP_LINK,
  FRONT_DESK_MENU,
  frontDeskRoleAllows,
  frontDeskRoleFromViewer,
  readFrontDeskSurfacePorts,
  readAvailableFrontDeskSurfaces,
  resolveFrontDeskMenu,
  type FrontDeskRole,
} from './front-desk-nav.js';
import { t, type VocabularyKey } from './t.js';

beforeEach(() => {
  loadSurfaceManifestMock.mockReset();
  healthFetchMock.mockReset();
  vi.stubGlobal('fetch', healthFetchMock);
  resolveBrowserUrlMock.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe('FRONT_DESK_MENU', () => {
  it('lists existing destinations in stable groups without an item limit', () => {
    expect(FRONT_DESK_MENU.map((item) => item.id)).toEqual([
      'home',
      'ask',
      'decide',
      'progress',
      'workspace',
      'missions',
      'work-items',
      'deliverables',
      'ingest',
      'knowledge',
      'discussion',
      'first-job',
      'help',
      'organization',
      'operations',
      'surface-control',
      'diagnostics',
      'settings',
    ]);
    expect(new Set(FRONT_DESK_MENU.map((item) => item.id)).size).toBe(FRONT_DESK_MENU.length);
    expect(FRONT_DESK_MENU.every((item) => !item.path.startsWith('/api/'))).toBe(true);
  });

  it('resolves every label_key/sublabel_key to a non-empty ja and en string with no internal leftovers or port numbers', () => {
    const forbiddenPatterns = [/Approval Inbox/i, /Hold To Talk/i, /3031/, /3050/];
    const keys = FRONT_DESK_MENU.flatMap((item) => [
      item.label_key,
      item.sublabel_key,
      item.group_key,
    ]);
    for (const key of keys) {
      for (const locale of ['en', 'ja'] as const) {
        const text = t(key as VocabularyKey, undefined, locale);
        expect(text.length).toBeGreaterThan(0);
        expect(text).not.toBe(key);
        for (const pattern of forbiddenPatterns) {
          expect(text).not.toMatch(pattern);
        }
      }
    }
  });

  it('keeps the help compatibility link aligned with its catalog entry', () => {
    expect(FRONT_DESK_HELP_LINK.id).toBe('help');
    const helpText = t(FRONT_DESK_HELP_LINK.label_key as VocabularyKey, undefined, 'ja');
    expect(helpText.length).toBeGreaterThan(0);
    expect(FRONT_DESK_MENU.find((item) => item.id === 'help')).toMatchObject({
      surface: FRONT_DESK_HELP_LINK.surface,
      path: FRONT_DESK_HELP_LINK.path,
    });
  });
});

describe('resolveFrontDeskMenu', () => {
  it('resolves relative hrefs for presence-studio items and external hrefs for concierge items when current surface is presence-studio', () => {
    const menu = resolveFrontDeskMenu({ currentSurface: 'presence-studio' });
    const byId = Object.fromEntries(menu.map((item) => [item.id, item]));

    expect(byId.home.href).toBe('/');
    expect(byId.home.external).toBe(false);
    expect(byId.ask.href).toBe('/ask');
    expect(byId.ask.external).toBe(false);
    expect(byId.progress.href).toBe('/progress');
    expect(byId.progress.external).toBe(false);

    expect(byId.decide.href).toBe('http://127.0.0.1:3050/');
    expect(byId.decide.external).toBe(true);
    expect(byId.settings.href).toBe('http://127.0.0.1:3050/settings');
    expect(byId.settings.external).toBe(true);
  });

  it('resolves the mirror case when current surface is concierge', () => {
    const menu = resolveFrontDeskMenu({ currentSurface: 'concierge' });
    const byId = Object.fromEntries(menu.map((item) => [item.id, item]));

    expect(byId.decide.href).toBe('/');
    expect(byId.decide.external).toBe(false);
    expect(byId.settings.href).toBe('/settings');
    expect(byId.settings.external).toBe(false);

    expect(byId.home.href).toBe('http://127.0.0.1:3031/');
    expect(byId.home.external).toBe(true);
    expect(byId.ask.href).toBe('http://127.0.0.1:3031/ask');
    expect(byId.ask.external).toBe(true);
    expect(byId.progress.href).toBe('http://127.0.0.1:3031/progress');
    expect(byId.progress.external).toBe(true);
  });

  it('honors custom ports overrides', () => {
    const menu = resolveFrontDeskMenu({
      currentSurface: 'presence-studio',
      ports: { concierge: 4000 },
    });
    const decide = menu.find((item) => item.id === 'decide')!;
    expect(decide.href).toBe('http://127.0.0.1:4000/');
  });

  it('gates allowed by role, defaulting to viewer when role is omitted', () => {
    const defaultMenu = resolveFrontDeskMenu({ currentSurface: 'presence-studio' });
    const byIdDefault = Object.fromEntries(defaultMenu.map((item) => [item.id, item]));
    expect(byIdDefault.home.allowed).toBe(true);
    expect(byIdDefault.progress.allowed).toBe(true);
    expect(byIdDefault.ask.allowed).toBe(false);
    expect(byIdDefault.decide.allowed).toBe(false);
    expect(byIdDefault.settings.allowed).toBe(false);

    const ownerMenu = resolveFrontDeskMenu({ currentSurface: 'presence-studio', role: 'owner' });
    expect(ownerMenu.every((item) => item.allowed)).toBe(true);
  });
});

describe('frontDeskRoleAllows', () => {
  const roles: FrontDeskRole[] = ['owner', 'approver', 'viewer'];

  it('matches the owner >= approver >= viewer ordering matrix', () => {
    const expected: Record<string, boolean> = {
      'owner:owner': true,
      'owner:approver': true,
      'owner:viewer': true,
      'approver:owner': false,
      'approver:approver': true,
      'approver:viewer': true,
      'viewer:owner': false,
      'viewer:approver': false,
      'viewer:viewer': true,
    };
    for (const role of roles) {
      for (const min of roles) {
        expect(frontDeskRoleAllows(role, min)).toBe(expected[`${role}:${min}`]);
      }
    }
  });
});

describe('frontDeskRoleFromViewer', () => {
  it('maps localadmin to owner and readonly to viewer', () => {
    expect(frontDeskRoleFromViewer({ role: 'localadmin' })).toBe('owner');
    expect(frontDeskRoleFromViewer({ role: 'readonly' })).toBe('viewer');
  });
});

describe('readFrontDeskSurfacePorts', () => {
  it('reads ports from the surface manifest when present and valid', () => {
    loadSurfaceManifestMock.mockReturnValue({
      version: 1,
      surfaces: [
        { id: 'presence-studio', kind: 'ui', description: '', command: 'node', port: 4031 },
        { id: 'concierge', kind: 'ui', description: '', command: 'node', port: 4050 },
      ],
    });
    const ports = readFrontDeskSurfacePorts();
    expect(ports['presence-studio']).toBe(4031);
    expect(ports.concierge).toBe(4050);
  });

  it('falls back to defaults for surfaces missing from the manifest', () => {
    loadSurfaceManifestMock.mockReturnValue({
      version: 1,
      surfaces: [
        { id: 'presence-studio', kind: 'ui', description: '', command: 'node', port: 4031 },
      ],
    });
    const ports = readFrontDeskSurfacePorts();
    expect(ports['presence-studio']).toBe(4031);
    expect(ports.concierge).toBe(DEFAULT_FRONT_DESK_PORTS.concierge);
  });

  it('falls back to defaults when the manifest is unreadable', () => {
    loadSurfaceManifestMock.mockImplementation(() => {
      throw new Error('manifest not found');
    });
    const ports = readFrontDeskSurfacePorts();
    expect(ports).toEqual(DEFAULT_FRONT_DESK_PORTS);
    expect(typeof ports['presence-studio']).toBe('number');
    expect(typeof ports.concierge).toBe('number');
  });
});

describe('optional destinations', () => {
  it('omits unavailable surfaces without guessed ports', () => {
    const menu = resolveFrontDeskMenu({ currentSurface: 'concierge', role: 'owner' });
    expect(menu.map((item) => item.id)).toEqual([
      'home',
      'ask',
      'decide',
      'progress',
      'workspace',
      'ingest',
      'first-job',
      'help',
      'settings',
    ]);
    expect(
      menu.some(
        (item) => item.surface === 'chronos-mirror-v2' || item.surface === 'operator-surface'
      )
    ).toBe(false);
  });
  it('uses verified optional bases and preserves section selection', () => {
    const menu = resolveFrontDeskMenu({
      currentSurface: 'concierge',
      role: 'owner',
      availableSurfaces: {
        'chronos-mirror-v2': 'http://localhost:4300/',
        'operator-surface': 'http://localhost:4331',
      },
    });
    expect(menu).toHaveLength(FRONT_DESK_MENU.length);
    expect(menu.find((item) => item.id === 'missions')?.href).toBe(
      'http://localhost:4300/?section=missions'
    );
    expect(menu.some((item) => item.id === 'monitor')).toBe(false);
    expect(menu.find((item) => item.id === 'missions')?.scope_query_style).toBe('snake');
  });
  it.each(['viewer', 'operator', 'approver', 'owner'] as const)(
    'keeps role gates for %s with all surfaces available',
    (role) => {
      const menu = resolveFrontDeskMenu({
        currentSurface: 'presence-studio',
        role,
        availableSurfaces: {
          'chronos-mirror-v2': 'http://localhost:4300',
          'operator-surface': 'http://localhost:4331',
        },
      });
      for (const item of menu) expect(item.allowed).toBe(frontDeskRoleAllows(role, item.min_role));
      expect(menu.find((item) => item.id === 'settings')?.allowed).toBe(role === 'owner');
    }
  );
});

describe('readAvailableFrontDeskSurfaces', () => {
  const enabled = () =>
    loadSurfaceManifestMock.mockReturnValue({
      surfaces: [
        { id: 'chronos-mirror-v2', enabled: true, port: 3000, healthPath: '/api/healthz' },
        { id: 'operator-surface', enabled: true, port: 3331, healthPath: '/' },
      ],
    });
  it.each(['http://127.0.0.1:3000', 'http://localhost:3000', 'http://[::1]:3000'])(
    'probes the exact configured origin %s',
    async (base) => {
      enabled();
      resolveBrowserUrlMock.mockReturnValue(base);
      healthFetchMock.mockResolvedValue({ ok: true });
      expect(await readAvailableFrontDeskSurfaces()).toEqual({ 'chronos-mirror-v2': base });
      expect(String(healthFetchMock.mock.calls[0][0])).toBe(base + '/api/healthz');
      expect(healthFetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
      expect(healthFetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      expect(healthFetchMock).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    'http://remote.example:3000',
    'https://localhost:3000',
    'http://localhost:4000',
    'http://localhost:3000/unknown',
  ])('omits unverified target %s', async (base) => {
    enabled();
    resolveBrowserUrlMock.mockReturnValue(base);
    expect(await readAvailableFrontDeskSurfaces()).toEqual({});
    expect(healthFetchMock).not.toHaveBeenCalled();
  });
  it('omits disabled, unhealthy, missing and invalid configurations', async () => {
    loadSurfaceManifestMock.mockReturnValueOnce({
      surfaces: [
        { id: 'chronos-mirror-v2', enabled: false, port: 3000, healthPath: '/api/healthz' },
      ],
    });
    expect(await readAvailableFrontDeskSurfaces()).toEqual({});
    expect(healthFetchMock).not.toHaveBeenCalled();
    enabled();
    resolveBrowserUrlMock.mockReturnValue('http://localhost:3000');
    healthFetchMock.mockResolvedValue({ ok: false });
    expect(await readAvailableFrontDeskSurfaces()).toEqual({});
    healthFetchMock.mockRejectedValue(new Error('connect failed or timeout'));
    expect(await readAvailableFrontDeskSurfaces()).toEqual({});
    resolveBrowserUrlMock.mockReturnValue('invalid');
    expect(await readAvailableFrontDeskSurfaces()).toEqual({});
    loadSurfaceManifestMock.mockImplementation(() => {
      throw new Error('missing');
    });
    expect(await readAvailableFrontDeskSurfaces()).toEqual({});
  });
});
