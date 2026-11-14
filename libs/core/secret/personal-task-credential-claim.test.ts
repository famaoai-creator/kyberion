import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPersonalTaskCredentialClaim } from './personal-task-credential-claim.js';

const m = vi.hoisted(() => ({
  actor: vi.fn(),
  identity: vi.fn(),
  installed: vi.fn(),
  envelope: vi.fn(),
  minted: vi.fn(),
  item: vi.fn(),
  leases: vi.fn(),
}));
vi.mock('../authn/actor-context.js', () => ({ currentActor: m.actor }));
vi.mock('../foundation/credential-binding.js', () => ({ credentialExecutionIdentity: m.identity }));
vi.mock('../organization/personal-runtime-identity.js', () => ({
  inspectInstalledPersonalRuntime: m.installed,
}));
vi.mock('../scope-envelope.js', () => ({
  currentScopeEnvelope: m.envelope,
  getMintedEnvelope: m.minted,
}));
vi.mock('../workforce/work-coordination.js', () => ({
  getWorkItem: m.item,
  listActiveWorkLeases: m.leases,
}));

const actorId = 'kyberion://agent/_/_/personal-worker';
const scope = () => ({ tier: 'personal', mission_id: 'MSN-PERSONAL', task_id: 'task-a' });
const fixture = () => {
  const envelope = { identity: scope(), policy: { write_tier: 'personal' }, mint_ref: 'mint-a' };
  const actor = { actor: { kind: 'agent', id: actorId }, provenance: 'claim', scope: scope() };
  const installed = { ready: true, ownerId: 'user:owner', agentId: actorId, agentActive: true };
  const identity = { missionId: 'MSN-PERSONAL', taskId: 'task-a' };
  const attempt = {
    attempt_id: 'entry-a',
    run_id: 'run-a',
    status: 'running',
    lease_id: 'lease-a',
    actor_peer_id: actorId,
  };
  const item = {
    item_id: 'WI-personal',
    status: 'in_progress',
    lease_id: 'lease-a',
    current_attempt_id: 'run-a',
    claimed_by_peer_id: actorId,
    context: scope(),
    attempts: [attempt],
  };
  const lease = {
    lease_id: 'lease-a',
    item_id: 'WI-personal',
    status: 'active',
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    holder_peer_id: actorId,
  };
  return { envelope, actor, installed, identity, attempt, item, lease };
};
let f: ReturnType<typeof fixture>;
beforeEach(() => {
  vi.resetAllMocks();
  f = fixture();
  m.envelope.mockReturnValue(f.envelope);
  m.minted.mockReturnValue(f.envelope);
  m.actor.mockReturnValue(f.actor);
  m.identity.mockReturnValue(f.identity);
  m.installed.mockReturnValue(f.installed);
  m.item.mockReturnValue(f.item);
  m.leases.mockReturnValue([f.lease]);
});

describe('personal claimed credential admission', () => {
  it('returns only frozen identity proof from the installed owner and current run', () => {
    const proof = assertPersonalTaskCredentialClaim('WI-personal');
    expect(proof).toEqual({
      ownerId: 'user:owner',
      actorId,
      workItemId: 'WI-personal',
      attemptId: 'run-a',
      leaseId: 'lease-a',
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(m.installed).toHaveBeenCalledWith();
    expect(m.item).toHaveBeenCalledWith('WI-personal');
    expect(m.minted).toHaveBeenCalledWith('mint-a');
  });

  it.each(['envelope', 'actor', 'item'] as const)('rejects a missing %s', (key) => {
    m[key].mockReturnValue(undefined);
    expect(() => assertPersonalTaskCredentialClaim('WI-personal')).toThrow(
      'CREDENTIAL_PERSONAL_CLAIM_DENIED'
    );
  });

  it('does not accept a copied envelope with a real mint reference', () => {
    m.envelope.mockReturnValue({ ...f.envelope });
    expect(() => assertPersonalTaskCredentialClaim('WI-personal')).toThrow(
      'CREDENTIAL_PERSONAL_CLAIM_DENIED'
    );
  });

  it.each([
    'legacy-peer',
    'user:owner',
    'kyberion://agent/legacy/worker',
    'kyberion://agent/acme/_/worker',
  ])('rejects non-personal canonical actor %s even if the installation names it', (id) => {
    f.actor.actor.id = id;
    f.installed.agentId = id;
    expect(() => assertPersonalTaskCredentialClaim('WI-personal')).toThrow(
      'CREDENTIAL_PERSONAL_CLAIM_DENIED'
    );
  });

  it.each([
    () => {
      f.actor.provenance = 'explicit';
    },
    () => {
      f.actor.actor.kind = 'human';
    },
    () => {
      f.installed.ready = false;
    },
    () => {
      f.installed.agentActive = false;
    },
    () => {
      f.installed.agentId = 'kyberion://agent/_/_/other';
    },
    () => {
      f.installed.ownerId = 'owner';
    },
    () => {
      Object.assign(f.actor.actor, { on_behalf_of: 'user:other' });
    },
    () => {
      Object.assign(f.envelope.identity, { tenant_slug: 'acme' });
    },
    () => {
      Object.assign(f.envelope.identity, { organization_id: 'org' });
    },
    () => {
      Object.assign(f.identity, { tenantSlug: 'acme' });
    },
    () => {
      f.envelope.identity.mission_id = '';
    },
    () => {
      f.envelope.identity.task_id = '';
    },
    () => {
      f.envelope.identity.tier = 'confidential';
    },
    () => {
      f.envelope.policy.write_tier = 'public';
    },
    () => {
      Object.assign(f.envelope.identity, { nhi_id: 'kyberion://agent/_/_/other' });
    },
  ])('rejects inconsistent personal host or dispatch proof %#', (mutate) => {
    mutate();
    expect(() => assertPersonalTaskCredentialClaim('WI-personal')).toThrow(
      'CREDENTIAL_PERSONAL_CLAIM_DENIED'
    );
  });

  it.each([
    () => {
      f.item.status = 'done';
    },
    () => {
      f.item.item_id = 'WI-other';
    },
    () => {
      f.item.current_attempt_id = 'entry-a';
    },
    () => {
      f.attempt.status = 'released';
    },
    () => {
      f.attempt.lease_id = 'lease-other';
    },
    () => {
      f.attempt.actor_peer_id = 'kyberion://agent/_/_/other';
    },
    () => {
      f.item.claimed_by_peer_id = 'kyberion://agent/_/_/other';
    },
    () => {
      f.lease.holder_peer_id = 'kyberion://agent/_/_/other';
    },
    () => {
      f.lease.item_id = 'WI-other';
    },
    () => {
      f.lease.status = 'released';
    },
    () => {
      f.lease.expires_at = new Date(Date.now() - 1).toISOString();
    },
    () => {
      f.lease.expires_at = 'invalid';
    },
    () => {
      Object.assign(f.lease, { holder_user_id: 'user:other' });
    },
    () => {
      Object.assign(f.item, { claimed_by_user_id: 'user:other' });
    },
    () => {
      Object.assign(f.attempt, { actor_user_id: 'user:other' });
    },
  ])('rejects changed or stale claim %#', (mutate) => {
    assertPersonalTaskCredentialClaim('WI-personal');
    mutate();
    expect(() => assertPersonalTaskCredentialClaim('WI-personal')).toThrow(
      'CREDENTIAL_PERSONAL_CLAIM_DENIED'
    );
  });

  it.each(['tenant_slug', 'organization_id', 'project_id', 'mission_id', 'task_id'] as const)(
    'rejects a WorkItem or actor %s mismatch',
    (field) => {
      Object.assign(f.item.context, { [field]: 'other' });
      expect(() => assertPersonalTaskCredentialClaim('WI-personal')).toThrow(
        'CREDENTIAL_PERSONAL_CLAIM_DENIED'
      );
      f.item.context = scope();
      Object.assign(f.actor.scope, { [field]: 'other' });
      expect(() => assertPersonalTaskCredentialClaim('WI-personal')).toThrow(
        'CREDENTIAL_PERSONAL_CLAIM_DENIED'
      );
    }
  );

  it('permits a consistently scoped standalone public project without assigning a tenant', () => {
    for (const value of [f.envelope.identity, f.actor.scope, f.item.context])
      Object.assign(value, { tier: 'public', project_id: 'PRJ-PERSONAL' });
    f.envelope.policy.write_tier = 'public';
    expect(assertPersonalTaskCredentialClaim('WI-personal').ownerId).toBe('user:owner');
  });

  it('re-reads owner and claim generation instead of caching the first proof', () => {
    const first = assertPersonalTaskCredentialClaim('WI-personal');
    f.installed.ownerId = 'user:second';
    f.item.current_attempt_id = f.attempt.run_id = 'run-b';
    f.item.lease_id = f.attempt.lease_id = f.lease.lease_id = 'lease-b';
    const second = assertPersonalTaskCredentialClaim('WI-personal');
    expect(second).toEqual({
      ...first,
      ownerId: 'user:second',
      attemptId: 'run-b',
      leaseId: 'lease-b',
    });
    expect(first).toMatchObject({ ownerId: 'user:owner', attemptId: 'run-a', leaseId: 'lease-a' });
  });
});
