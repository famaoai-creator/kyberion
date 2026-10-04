import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TENANT_CHANGED_EVENT,
  tenantFromChangeEvent,
  withSelectedTenant,
  announceTenantChange,
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
