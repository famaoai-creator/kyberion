import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadSurfaceManifestMock = vi.hoisted(() => vi.fn());
const healthFetchMock = vi.hoisted(() => vi.fn());
const resolveBrowserUrlMock = vi.hoisted(() => vi.fn());
vi.mock('./surface-url.js', () => ({ resolveSurfaceBrowserUrl: resolveBrowserUrlMock }));

vi.mock('./surface-runtime.js', () => ({
  loadSurfaceManifest: loadSurfaceManifestMock,
}));

import {
  DEFAULT_FRONT_DESK_PORTS,
  FRONT_DESK_HELP_LINK,
  FRONT_DESK_LINKED_DESTINATIONS,
  FRONT_DESK_MENU,
  frontDeskRoleAllows,
  frontDeskRoleFromViewer,
  readFrontDeskSurfacePorts,
  readAvailableFrontDeskSurfaces,
  resolveFrontDeskDestination,
  resolveFrontDeskMenu,
  type FrontDeskRole,
} from './front-desk-nav.js';
import { t, type VocabularyKey } from '../localization/t.js';

beforeEach(() => {
  loadSurfaceManifestMock.mockReset();
  healthFetchMock.mockReset();
  vi.stubGlobal('fetch', healthFetchMock);
  resolveBrowserUrlMock.mockReset();
});

afterEach(() => vi.unstubAllGlobals());

describe('FRONT_DESK_MENU', () => {
  it('lists exactly the seven top-level destinations (MSN-SHELL-IA §1)', () => {
    expect(FRONT_DESK_MENU.map((item) => item.id)).toEqual([
      'home',
      'inbox',
      'work',
      'org',
      'library',
      'ops',
      'settings',
    ]);
    expect(new Set(FRONT_DESK_MENU.map((item) => item.id)).size).toBe(FRONT_DESK_MENU.length);
    expect(FRONT_DESK_MENU.every((item) => !item.path.startsWith('/api/'))).toBe(true);
  });

  it('resolves every label_key/sublabel_key to a non-empty ja and en string with no internal leftovers or port numbers', () => {
    const forbiddenPatterns = [/Approval Inbox/i, /Hold To Talk/i, /3031/, /3050/];
    const keys = [...FRONT_DESK_MENU, ...FRONT_DESK_LINKED_DESTINATIONS].flatMap((item) => [
      item.label_key,
      item.sublabel_key,
      ...(item.group_key ? [item.group_key] : []),
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
    // Help left the rail (it is not one of the seven destinations) but stays linkable.
    expect(FRONT_DESK_MENU.some((item) => item.id === 'help')).toBe(false);
    expect(FRONT_DESK_LINKED_DESTINATIONS.find((item) => item.id === 'help')).toMatchObject({
      surface: FRONT_DESK_HELP_LINK.surface,
      path: FRONT_DESK_HELP_LINK.path,
    });
  });
});

describe('resolveFrontDeskMenu', () => {
  it('resolves relative hrefs for presence-studio items and external hrefs for concierge items when current surface is presence-studio', () => {
    const menu = resolveFrontDeskMenu({ currentSurface: 'presence-studio' });
    const byId = Object.fromEntries(menu.map((item) => [item.id, item]));

    expect(byId.home.href).toBe('http://127.0.0.1:3050/');
    expect(byId.work.href).toBe('http://127.0.0.1:3050/work');

    expect(byId.inbox.href).toBe('http://127.0.0.1:3050/inbox');
    expect(byId.inbox.external).toBe(true);
    expect(byId.settings.href).toBe('http://127.0.0.1:3050/settings');
    expect(byId.settings.external).toBe(true);
  });

  it('resolves the mirror case when current surface is concierge', () => {
    const menu = resolveFrontDeskMenu({ currentSurface: 'concierge' });
    const byId = Object.fromEntries(menu.map((item) => [item.id, item]));

    expect(byId.home.href).toBe('/');
    expect(byId.inbox.href).toBe('/inbox');
    expect(byId.settings.href).toBe('/settings');
    expect(byId.settings.external).toBe(false);
    expect(byId.org.href).toBe('/org');
    expect(byId.library.href).toBe('/library');
    expect(byId.ops.href).toBe('/ops');
    expect(menu.every((item) => !item.external)).toBe(true);
    // The old `/w/*` lists and `/ops?section=*` entries are no longer rail items.
    expect(
      menu.some((item) => /^\/w(\/|$)/.test(item.href) || item.href.includes('section='))
    ).toBe(false);
  });

  it('honors custom ports overrides', () => {
    const menu = resolveFrontDeskMenu({
      currentSurface: 'presence-studio',
      ports: { concierge: 4000 },
    });
    const inbox = menu.find((item) => item.id === 'inbox')!;
    expect(inbox.href).toBe('http://127.0.0.1:4000/inbox');
  });

  it('gates allowed by role, defaulting to viewer when role is omitted', () => {
    const defaultMenu = resolveFrontDeskMenu({ currentSurface: 'presence-studio' });
    const byIdDefault = Object.fromEntries(defaultMenu.map((item) => [item.id, item]));
    expect(byIdDefault.home.allowed).toBe(true);
    expect(byIdDefault.work.allowed).toBe(true);
    expect(byIdDefault.inbox.allowed).toBe(false);
    expect(byIdDefault.ops.allowed).toBe(false);
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
  it('hosts the operations console items on Concierge and needs no optional surface', () => {
    const menu = resolveFrontDeskMenu({ currentSurface: 'concierge', role: 'owner' });
    expect(menu.map((item) => item.id)).toEqual([
      'home',
      'inbox',
      'work',
      'org',
      'library',
      'ops',
      'settings',
    ]);
    expect(
      menu.some(
        (item) => item.surface === 'chronos-mirror-v2' || item.surface === 'operator-surface'
      )
    ).toBe(false);
  });
  it('keeps /ops section links same-origin with the snake_case scope query', () => {
    const menu = resolveFrontDeskMenu({
      currentSurface: 'concierge',
      role: 'owner',
      availableSurfaces: {
        'chronos-mirror-v2': 'http://localhost:4300/',
        'operator-surface': 'http://localhost:4331',
      },
    });
    expect(menu).toHaveLength(FRONT_DESK_MENU.length);
    // The former Chronos destinations are same-origin /ops sections now, even
    // while a Chronos process is still reachable during the migration.
    expect(menu.find((item) => item.id === 'ops')?.href).toBe('/ops');
    expect(menu.find((item) => item.id === 'ops')?.external).toBe(false);
    expect(menu.some((item) => item.id === 'monitor')).toBe(false);
    expect(menu.find((item) => item.id === 'ops')?.scope_query_style).toBe('snake');
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

describe('rail placement and destinations', () => {
  it('pins settings at the rail bottom and keeps the rest in the main list', () => {
    expect(FRONT_DESK_MENU.filter((item) => item.placement === 'footer').map((i) => i.id)).toEqual([
      'settings',
    ]);
    expect(FRONT_DESK_MENU.every((item) => !item.group_key)).toBe(true);
  });

  it('keeps the operations console same-origin with the snake_case scope query', () => {
    const menu = resolveFrontDeskMenu({
      currentSurface: 'presence-studio',
      role: 'owner',
      urls: { concierge: 'http://127.0.0.1:3050' },
    });
    const ops = menu.find((entry) => entry.id === 'ops');
    expect(ops).toMatchObject({
      surface: 'concierge',
      href: 'http://127.0.0.1:3050/ops',
      scope_query_style: 'snake',
      min_role: 'owner',
    });
    expect(menu.find((entry) => entry.id === 'org')?.scope_query_style).toBe('camel');
    expect(FRONT_DESK_MENU.some((item) => item.surface === 'chronos-mirror-v2')).toBe(false);
  });

  it('still resolves Studio destinations that left the rail', () => {
    for (const id of ['ask', 'first-job', 'progress', 'home-studio']) {
      expect(
        resolveFrontDeskDestination(id, { currentSurface: 'concierge', role: 'owner' })?.surface,
        id
      ).toBe('presence-studio');
    }
  });

  it('resolves 使い方 on Concierge itself (moved in Kyberion server phase 2)', () => {
    const help = resolveFrontDeskDestination('help', {
      currentSurface: 'concierge',
      role: 'viewer',
    });
    expect(help).toMatchObject({
      surface: 'concierge',
      href: '/help',
      external: false,
      allowed: true,
    });
  });
});
