/** Real scoped approval IO; no external notification or human approval is fabricated. */
import * as path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { seedFirstJobTestRoot } from '../../../scripts/fixtures/first-job-approval-fixture.js';
import { safeRmSync as removeRoot } from '../secure-io.js';
const previous = process.cwd();
const root = path.join(previous, 'active/shared/tmp', `personal-approval-${randomUUID()}`);
let store: typeof import('./approval-store.js');
let location: typeof import('./approval-store-location.js');
let envelopes: typeof import('../scope-envelope.js');
let authority: typeof import('../authority.js');
let io: typeof import('../secure-io.js');
let paths: typeof import('../path-resolver.js');
beforeAll(async () => {
  seedFirstJobTestRoot(previous, root);
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('KYBERION_TIER', 'public');
  for (const key of [
    'MISSION_ID',
    'KYBERION_TENANT',
    'KYBERION_TASK_ID',
    'KYBERION_PROJECT_ID',
    'KYBERION_ORGANIZATION_ID',
    'SYSTEM_ROLE',
  ])
    vi.stubEnv(key, '');
  vi.resetModules();
  store = await import('./approval-store.js');
  location = await import('./approval-store-location.js');
  envelopes = await import('../scope-envelope.js');
  authority = await import('../authority.js');
  io = await import('../secure-io.js');
  paths = await import('../path-resolver.js');
}, 60000);
afterAll(() => {
  process.chdir(previous);
  vi.unstubAllEnvs();
  removeRoot(root, { recursive: true, force: true });
});
function asOwner<T>(owner: string, run: () => T): T {
  const envelope = envelopes.mintScopeEnvelope({
    identity: { tier: 'personal', nhi_id: owner, session_id: 'personal-store-fixture' },
    policy: {
      read_tiers: ['public', 'personal'],
      write_tier: 'personal',
      purpose: 'Synthetic owner approval IO',
    },
    env: { ...process.env, KYBERION_TIER: 'personal' },
  });
  return envelopes.withScopeEnvelope(envelope, () =>
    authority.withExecutionContext('mission_controller', run)
  );
}
describe('actual personal owner approval partition', () => {
  it('stores privately by actual owner, rejects public/other-owner reads and mutations, and keeps hashes intact', () => {
    const owner = 'personal-owner-a';
    const channel = 'personal-source';
    const record = asOwner(owner, () =>
      store.createApprovalRequest('mission_controller', {
        channel,
        requestedBy: owner,
        threadTs: '1',
        correlationId: 'personal-store',
        scope: { scope_kind: 'system', tier: 'personal', nhi_id: owner },
        draft: { title: 'Private source approval', summary: 'private fixture bytes' },
        accountability: {
          finalDecision: 'human_only',
          payloadHash: 'a'.repeat(64),
          effectBinding: 'personal-source-fixture',
        },
      })
    );
    const located = asOwner(owner, () => location.locateApprovalRequest(channel, record.id))!;
    expect(located.partition).toEqual({
      kind: 'personal',
      tier: 'personal',
      owner_hash: createHash('sha256').update(owner).digest('hex'),
    });
    const file = paths.pathResolver.rootResolve(
      location.approvalRequestLogicalPathAt(located.partition, channel, record.id)
    );
    expect(store.loadApprovalRequest(channel, record.id)).toBeNull();
    expect(store.listApprovalRequests({ storageChannels: [channel] })).toEqual([]);
    expect(() =>
      authority.withExecutionContext('worker', () => io.safeReadFile(file), 'worker')
    ).toThrow();
    expect(
      asOwner('personal-owner-b', () => store.loadApprovalRequest(channel, record.id))
    ).toBeNull();
    expect(() =>
      asOwner('personal-owner-b', () =>
        store.decideApprovalRequest('mission_controller', {
          channel,
          requestId: record.id,
          decision: 'rejected',
          decidedBy: 'synthetic-other',
        })
      )
    ).toThrow();
    expect(() => location.asTenantApprovalStore('shared', () => io.safeReadFile(file))).toThrow();
    const reread = asOwner(owner, () => store.loadApprovalRequest(channel, record.id))!;
    expect(reread.summary).toBe('private fixture bytes');
    expect(reread.scope?.tenant_slug).toBeUndefined();
    expect(reread.accountability?.payloadHash).toBe(record.accountability?.payloadHash);
    const cancelled = asOwner(owner, () =>
      store.cancelApprovalRequest('mission_controller', {
        channel,
        requestId: record.id,
        cancelledBy: 'synthetic-owner',
      })
    );
    expect(cancelled.status).toBe('cancelled');
    expect(asOwner(owner, () => store.loadApprovalRequest(channel, record.id))?.status).toBe(
      'cancelled'
    );
    expect(() =>
      authority.withExecutionContext('personal_approval_store', () => undefined)
    ).toThrow('PERSONAL_APPROVAL_SCOPE_REQUIRED');
  });
  it('fences legacy system personal visibility and cached seed scope after leaving its owner', () => {
    const owner = 'legacy-personal-owner';
    const scope = { scope_kind: 'system' as const, tier: 'personal' as const, nhi_id: owner };
    expect(location.systemRecordVisibleToThisProcess({ scope })).toBe(false);
    expect(asOwner(owner, () => location.systemRecordVisibleToThisProcess({ scope }))).toBe(true);
    expect(
      asOwner('foreign-owner', () => location.systemRecordVisibleToThisProcess({ scope }))
    ).toBe(false);
    const entry: import('./approval-store.js').SessionApprovalCacheEntry = {
      key: 'synthetic::scope-denial-only',
      action: 'synthetic',
      targetClass: 'scope-denial-only',
      grantedByRequestId: 'never-issued',
      grantedBy: 'not-used-for-decision',
      grantedForAgent: owner,
      grantedAt: new Date().toISOString(),
      channel: 'personal-source',
      storageChannel: 'personal-source',
      payloadHash: 'a'.repeat(64),
      effectBinding: 'denial-only',
      seedPartition: { kind: 'system' },
      personalOwnerHash: createHash('sha256').update(owner).digest('hex'),
    };
    expect(store.resolveSessionCacheSeed(entry).status).toBe('unusable');
    expect(asOwner('foreign-owner', () => store.resolveSessionCacheSeed(entry)).status).toBe(
      'unusable'
    );
  });
});
