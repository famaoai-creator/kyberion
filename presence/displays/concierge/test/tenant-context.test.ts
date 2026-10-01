import { describe, expect, it } from 'vitest';
import { TENANT_CHANGED_EVENT, tenantFromChangeEvent } from '../src/lib/tenant-context';

const eventWith = (detail: unknown) => ({ type: TENANT_CHANGED_EVENT, detail }) as unknown as Event;

describe('tenant context event', () => {
  it('reads the slug from a switch event and ignores anything malformed', () => {
    expect(tenantFromChangeEvent(eventWith({ tenant: 'acme' }))).toBe('acme');
    expect(tenantFromChangeEvent(eventWith({ tenant: '' }))).toBeNull();
    expect(tenantFromChangeEvent(eventWith({ tenant: 3 }))).toBeNull();
    expect(tenantFromChangeEvent(eventWith(null))).toBeNull();
  });
});
