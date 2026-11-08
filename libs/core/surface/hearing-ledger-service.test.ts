// S3 (MSN-SERVER-CONCIERGE-ASK-20261108): `recordHearingDecisions` saves the
// hearing record without the storage facade's write guard, so it checks the
// surface's owner decision itself — before reading the record, spawning the
// decisions facade or saving anything.
import { describe, expect, it, vi } from 'vitest';
const exec = vi.hoisted(() => vi.fn());
vi.mock('@agent/core/secure-io', async (original) => ({
  ...(await original<typeof import('@agent/core/secure-io')>()),
  safeExecResult: exec,
}));
import { HearingLedgerRequestError, recordHearingDecisions } from './hearing-ledger-service.js';
import type { HearingRouteContext } from './hearing-route-context.js';
import type { HearingStorage } from './hearing-storage-access.js';

function context(owner: boolean) {
  const load = vi.fn(() => null);
  const denied = vi.fn((status: number, message: string) => new Error(`${status} ${message}`));
  const ctx = {
    viewer: {
      role: 'localadmin',
      tenantSlugs: ['acme-corp'],
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['confidential', 'public'],
      source: 'token',
      principalId: 'human:test',
    },
    owner,
    currentSurface: 'concierge',
    storage: () => ({ namespace: 'acme-corp', load }) as unknown as HearingStorage,
    handoffScope: () => ({}),
    denied,
    audit: () => undefined,
    recordInScope: () => true,
  } as unknown as HearingRouteContext;
  return { ctx, load, denied };
}

describe('recordHearingDecisions owner check', () => {
  it('refuses a non-owner before reading the record, spawning the facade or saving', () => {
    const { ctx, load, denied } = context(false);
    expect(() => recordHearingDecisions(ctx, 'session-1', { case: 'case-a' }, {})).toThrow(
      '403 Hearing writes require a local owner session.'
    );
    expect(denied).toHaveBeenCalledWith(403, 'Hearing writes require a local owner session.');
    expect(load).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('lets the owner through to the record (here missing: the step’s own 400)', () => {
    const { ctx, load } = context(true);
    expect(() => recordHearingDecisions(ctx, 'session-1', { case: 'case-a' }, {})).toThrow(
      HearingLedgerRequestError
    );
    expect(load).toHaveBeenCalledWith('session-1');
    expect(exec).not.toHaveBeenCalled();
  });
});
