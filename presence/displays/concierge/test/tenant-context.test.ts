import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TENANT_CHANGED_EVENT,
  tenantFromChangeEvent,
  withSelectedTenant,
  announceTenantChange,
  readSelectedTenant,
  readTenantSelection,
  selectionFromPageUrl,
  selectionSwitchHref,
  syncSelectionCookieFromUrl,
  writeSelectionCookie,
} from '../src/lib/tenant-context';

const eventWith = (detail: unknown) => ({ type: TENANT_CHANGED_EVENT, detail }) as unknown as Event;

describe('tenant context event', () => {
  it('reads the slug from a switch event and ignores anything malformed', () => {
    expect(tenantFromChangeEvent(eventWith({ tenant: 'acme' }))).toBe('acme');
    expect(tenantFromChangeEvent(eventWith({ tenant: '' }))).toBeNull();
    expect(tenantFromChangeEvent(eventWith({ tenant: 3 }))).toBeNull();
    expect(tenantFromChangeEvent(eventWith(null))).toBeNull();
  });
});

afterEach(() => vi.unstubAllGlobals());
it('preserves explicit nested selection across same-origin and configured remote links', () => {
  vi.stubGlobal('window', {
    location: {
      href: 'https://desk.test/?tenant=alpha&organizationId=org-a&projectId=project-a',
      origin: 'https://desk.test',
    },
  });
  expect(withSelectedTenant('/progress', 'alpha')).toBe(
    '/progress?tenant=alpha&organizationId=org-a&projectId=project-a'
  );
  expect(withSelectedTenant('https://presence.test/ask', 'alpha')).toBe(
    'https://presence.test/ask?tenant=alpha&organizationId=org-a&projectId=project-a'
  );
});
it('clears obsolete nested selection on a tenant switch', () => {
  const replaceState = vi.fn();
  vi.stubGlobal('window', {
    location: { href: 'https://desk.test/?tenant=alpha&organizationId=org-a&projectId=project-a' },
    history: { state: null, replaceState },
    dispatchEvent: vi.fn(),
  });
  vi.stubGlobal(
    'CustomEvent',
    class {
      constructor(
        readonly name: string,
        readonly data: unknown
      ) {}
    }
  );
  announceTenantChange('beta');
  expect(replaceState).toHaveBeenCalledWith(null, '', '/?tenant=beta');
});

describe('company selection cookie and URL', () => {
  function stubBrowser(href: string, cookie = '') {
    const doc = { cookie };
    vi.stubGlobal('window', { location: new URL(href) });
    vi.stubGlobal('document', doc);
    return doc;
  }

  it('reads the URL before the cookie and treats personal as no company', () => {
    stubBrowser('https://desk.test/?tenant=acme', 'kyberion_selected_tenant=beta');
    expect(readTenantSelection()).toBe('acme');
    stubBrowser('https://desk.test/', 'a=1; kyberion_selected_tenant=beta');
    expect(readSelectedTenant()).toBe('beta');
    stubBrowser('https://desk.test/?tenant=personal');
    expect(readTenantSelection()).toBe('personal');
    expect(readSelectedTenant()).toBeNull();
    stubBrowser('https://desk.test/?tenant=shared');
    expect(readTenantSelection()).toBe('shared');
    expect(readSelectedTenant()).toBeNull();
  });

  it("reads this page's own URL selection without falling back to the shared cookie", () => {
    stubBrowser('https://desk.test/?tenant=beta', 'kyberion_selected_tenant=acme');
    expect(selectionFromPageUrl()).toBe('beta');
    stubBrowser('https://desk.test/', 'kyberion_selected_tenant=acme');
    expect(selectionFromPageUrl()).toBeNull();
    stubBrowser('https://desk.test/?tenant=Bad%20Value');
    expect(selectionFromPageUrl()).toBeNull();
  });

  it('syncs the URL selection into a Lax, path-wide, Secure-on-https cookie', () => {
    const doc = stubBrowser(
      'https://desk.test/settings?tenant=acme',
      'kyberion_selected_tenant=beta'
    );
    syncSelectionCookieFromUrl();
    expect(doc.cookie).toBe(
      'kyberion_selected_tenant=acme; Path=/; SameSite=Lax; Max-Age=31536000; Secure'
    );
  });

  it('never writes a malformed value into the cookie', () => {
    const doc = stubBrowser('http://localhost:3000/?tenant=acme;%20Domain=evil.test', 'x=1');
    syncSelectionCookieFromUrl();
    writeSelectionCookie('Acme Corp');
    expect(doc.cookie).toBe('x=1');
  });

  it('switches company without carrying the old organization or project', () => {
    expect(
      selectionSwitchHref(
        'https://desk.test/management?tenant=acme&organization_id=o1&projectId=p1#x',
        'beta'
      )
    ).toBe('/management?tenant=beta#x');
  });
});
