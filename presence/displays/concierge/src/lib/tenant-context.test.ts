import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { safeReadFile } from '@agent/core/secure-io';
import { announceTenantChange, withSelectedTenant } from './tenant-context';

type Prefs = {
  scopedUrl(path: string, style?: 'snake' | 'camel'): string;
  setTenant(tenant: string): void;
};
function browser(href: string) {
  const location = new URL(href);
  const history = { state: null, replaceState: vi.fn() };
  const window = {
    location,
    history,
    dispatchEvent: vi.fn(),
    localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
  };
  vi.stubGlobal('window', window);
  const root = { setAttribute: vi.fn(), removeAttribute: vi.fn(), getAttribute: () => 'en' };
  runInNewContext(
    String(safeReadFile('presence/displays/presence-studio/static/front-desk-prefs.js')),
    {
      window,
      document: { documentElement: root, cookie: '' },
      navigator: { language: 'en' },
      URL,
      URLSearchParams,
    }
  );
  return { window, prefs: (window as typeof window & { KyberionPrefs: Prefs }).KyberionPrefs };
}
afterEach(() => vi.unstubAllGlobals());
describe('front-desk destination scope parity', () => {
  it.each(['snake', 'camel'] as const)(
    'keeps tenant, organization and project using %s destination keys',
    (style) => {
      const h = browser(
        'http://localhost:3050/settings?tenant=alpha&organizationId=org-1&projectId=proj-1'
      );
      const target = 'http://localhost:3000/?section=missions#details';
      const react = withSelectedTenant(target, 'alpha', style);
      const vanilla = h.prefs.scopedUrl(target, style);
      expect(vanilla).toBe(react);
      const url = new URL(react);
      expect(url.searchParams.get('tenant')).toBe('alpha');
      expect(url.searchParams.get(style === 'snake' ? 'organization_id' : 'organizationId')).toBe(
        'org-1'
      );
      expect(url.searchParams.get(style === 'snake' ? 'project_id' : 'projectId')).toBe('proj-1');
      expect(url.searchParams.has(style === 'snake' ? 'organizationId' : 'organization_id')).toBe(
        false
      );
      expect(url.searchParams.get('section')).toBe('missions');
      expect(url.hash).toBe('#details');
    }
  );
  it('normalizes snake-case source context back to primary camel-case routes', () => {
    const h = browser(
      'http://localhost:3050/settings?tenant=alpha&organization_id=org&project_id=proj'
    );
    expect(h.prefs.scopedUrl('/ingest')).toBe(withSelectedTenant('/ingest', 'alpha'));
    expect(withSelectedTenant('/ingest', 'alpha')).toContain('organizationId=org');
  });
  it('clears both scope aliases when switching tenants', () => {
    const h = browser(
      'http://localhost:3050/settings?tenant=alpha&organizationId=old&projectId=old&organization_id=old&project_id=old'
    );
    announceTenantChange('beta');
    expect(h.window.history.replaceState).toHaveBeenLastCalledWith(
      null,
      '',
      '/settings?tenant=beta'
    );
    h.prefs.setTenant('beta');
    expect(h.window.history.replaceState).toHaveBeenLastCalledWith(
      null,
      '',
      '/settings?tenant=beta'
    );
  });
});

it('preserves the Management hierarchy when leaving and returning through the rail', () => {
  browser('http://localhost:3050/management?tenant=alpha&organization_id=org-a&project_id=prj-a');
  const destination = withSelectedTenant('/settings', 'alpha');
  browser(new URL(destination, 'http://localhost:3050').href);
  const returned = new URL(withSelectedTenant('/management', 'alpha'), 'http://localhost:3050');
  expect(returned.pathname).toBe('/management');
  expect(Object.fromEntries(returned.searchParams)).toEqual({
    tenant: 'alpha',
    organizationId: 'org-a',
    projectId: 'prj-a',
  });
});
