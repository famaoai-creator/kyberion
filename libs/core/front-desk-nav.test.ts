import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadSurfaceManifestMock = vi.hoisted(() => vi.fn());

vi.mock('./surface-runtime.js', () => ({
  loadSurfaceManifest: loadSurfaceManifestMock,
}));

import {
  DEFAULT_FRONT_DESK_PORTS,
  FRONT_DESK_HELP_LINK,
  FRONT_DESK_MENU,
  frontDeskRoleAllows,
  frontDeskRoleFromViewer,
  readFrontDeskSurfacePorts,
  resolveFrontDeskMenu,
  type FrontDeskRole,
} from './front-desk-nav.js';
import { t, type VocabularyKey } from './t.js';

beforeEach(() => {
  loadSurfaceManifestMock.mockReset();
});

describe('FRONT_DESK_MENU', () => {
  it('has exactly 5 items in home/ask/decide/progress/settings order', () => {
    expect(FRONT_DESK_MENU.map((item) => item.id)).toEqual([
      'home',
      'ask',
      'decide',
      'progress',
      'settings',
    ]);
  });

  it('resolves every label_key/sublabel_key to a non-empty ja and en string with no internal leftovers or port numbers', () => {
    const forbiddenPatterns = [/Approval Inbox/i, /Hold To Talk/i, /3031/, /3050/];
    const keys = FRONT_DESK_MENU.flatMap((item) => [item.label_key, item.sublabel_key]);
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

  it('defines the help link outside the 5-item menu', () => {
    expect(FRONT_DESK_HELP_LINK.id).toBe('help');
    const helpText = t(FRONT_DESK_HELP_LINK.label_key as VocabularyKey, undefined, 'ja');
    expect(helpText.length).toBeGreaterThan(0);
    expect(FRONT_DESK_MENU.some((item) => (item as { id: string }).id === 'help')).toBe(false);
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
