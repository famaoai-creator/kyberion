import { describe, expect, it } from 'vitest';
import {
  eventScopeFromRecord,
  eventScopeMatches,
  normalizeEventScope,
  parseEventScopeInput,
  parseEventScopeFromRecord,
  redactEventScopeForShared,
  resolveEventScopeAgainstAuthority,
} from './event-scope.js';

describe('event scope', () => {
  it('strictly parses untrusted scope input before normalization', () => {
    expect(
      parseEventScopeInput({ tier: 'confidential', tenant_slug: 'client-a', scope_kind: 'tenant' })
    ).toEqual({ tier: 'confidential', tenant_slug: 'client-a', scope_kind: 'tenant' });

    for (const value of [
      null,
      [],
      { tier: ['confidential'] },
      { tenant_slug: { value: 'client-a' } },
      { tier: 'unknown' },
      { scope_kind: 'unknown' },
      { tenant_slug: 'client-a', unexpected: 'widen-scope' },
    ]) {
      expect(() => parseEventScopeInput(value)).toThrow('EVENT_SCOPE_INPUT_INVALID');
    }
  });

  it('distinguishes system events from tenant/entity events', () => {
    expect(normalizeEventScope({ tier: 'public' })).toMatchObject({
      scope_kind: 'system',
      tier: 'public',
    });
    expect(
      normalizeEventScope({
        tier: 'confidential',
        tenant_slug: 'kyberion-service-studio',
        organization_id: 'kyberion-development-team',
        project_id: 'PRJ-1',
        mission_id: 'MSN-1',
        task_id: 'TASK-1',
      })
    ).toMatchObject({ scope_kind: 'task', tenant_slug: 'kyberion-service-studio' });
  });

  it('rejects a partition name in the tenant position', () => {
    expect(() => normalizeEventScope({ tier: 'confidential', tenant_slug: 'shared' })).toThrow(
      'SCOPE_CONTEXT_INVALID'
    );
  });

  it('fails closed for tenant reads of an unscoped or other-tenant event', () => {
    const tenant = normalizeEventScope({ tier: 'confidential', tenant_slug: 'client-a' });
    const other = normalizeEventScope({ tier: 'confidential', tenant_slug: 'client-b' });
    expect(eventScopeMatches(tenant, { tenant_slug: 'client-a' })).toBe(true);
    expect(eventScopeMatches(other, { tenant_slug: 'client-a' })).toBe(false);
    expect(eventScopeMatches(undefined, { tenant_slug: 'client-a' })).toBe(false);
  });

  it('reads the nested canonical scope and preserves the legacy flat fallback', () => {
    expect(
      eventScopeFromRecord({
        scope: { tier: 'confidential', tenant_slug: 'client-a', scope_kind: 'tenant' },
      })
    ).toMatchObject({ scope_kind: 'tenant', tenant_slug: 'client-a' });
    expect(eventScopeFromRecord({ tenant_slug: 'client-a', tier: 'confidential' })).toMatchObject({
      scope_kind: 'tenant',
      tenant_slug: 'client-a',
    });
  });

  it('rejects a supplied scope that crosses the authoritative containment chain', () => {
    const authority = normalizeEventScope({
      tier: 'confidential',
      tenant_slug: 'client-a',
      organization_id: 'org-a',
      project_id: 'project-a',
      mission_id: 'MSN-A',
    });

    expect(() =>
      resolveEventScopeAgainstAuthority(
        authority,
        { tier: 'confidential', tenant_slug: 'client-b' },
        { mission_id: 'MSN-A', task_id: 'task-a', scope_kind: 'task' }
      )
    ).toThrow('EVENT_SCOPE_LINEAGE_CONFLICT');
  });

  it('removes identity and customer stance metadata from shared scopes', () => {
    const shared = redactEventScopeForShared(
      normalizeEventScope({
        tier: 'confidential',
        tenant_slug: 'client-a',
        mission_id: 'MSN-A',
        customer_stance: 'customer-a',
        viewer_principal: 'human:alice',
        nhi_id: 'kyberion://agent/client-a/worker',
      })
    );

    expect(shared).toMatchObject({ tenant_slug: 'client-a', mission_id: 'MSN-A' });
    expect(shared.customer_stance).toBeUndefined();
    expect(shared.viewer_principal).toBeUndefined();
    expect(shared.nhi_id).toBeUndefined();
  });

  it('distinguishes malformed nested scope metadata from an absent scope', () => {
    expect(parseEventScopeFromRecord({}).invalid).toBe(false);
    expect(
      parseEventScopeFromRecord({
        scope: { scope_kind: 'organization', tier: 'confidential', tenant_slug: 'client-a' },
      }).invalid
    ).toBe(true);
    expect(
      parseEventScopeFromRecord({
        tenant_slug: 'client-b',
        scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'client-a' },
      })
    ).toMatchObject({ has_scope: true, invalid: true });
    expect(
      parseEventScopeFromRecord({
        scope_kind: 'not-a-scope',
        tier: 'public',
        session_id: 'SESSION-1',
        task_id: 'TASK-1',
        mission_id: 'MSN-1',
      })
    ).toMatchObject({ has_scope: true, invalid: true });
  });
});
