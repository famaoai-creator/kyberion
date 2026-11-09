import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as writerLease from '../lease/writer-lease.js';
import { pathResolver } from '../path-resolver.js';
import { safeAppendFileSync, safeExistsSync, safeMkdir, safeRmSync } from '../secure-io.js';
import { withExecutionContext } from '../authority.js';
import { assertRuntimeNhiScope } from '../tool/runtime-scope.js';
import {
  activateAgentIdentity,
  activateProvisionedAgentIdentity,
  AGENT_IDENTITY_OPS,
  AgentIdentityAccountabilityError,
  AgentIdentityConflictError,
  AgentIdentityFormatError,
  AgentIdentityGovernedError,
  AgentIdentityJournal,
  AgentIdentityLifecycleError,
  AgentIdentityNotFoundError,
  bindRuntimeInstance,
  buildNhiId,
  deriveAgentNhiId,
  ensureAgentIdentityBestEffort,
  ensureAgentIdentityProvisioned,
  getAgentIdentity,
  getAgentIdentityRevision,
  reassignAgentIdentityAccountability,
  issueAgentIdentity,
  listAgentIdentities,
  parseNhiId,
  releaseRuntimeInstance,
  resetAgentIdentityServiceForTests,
  retireAgentIdentity,
  suspendAgentIdentity,
} from './agent-identity.js';

/**
 * NI-01 tests. Hermetic: every test points the module-level singleton at a
 * fresh, unique journal path under active/shared/tmp/ (never the governed
 * default path), via `resetAgentIdentityServiceForTests` — mirrors the SO-02
 * `orchestrator-session.test.ts` unique-tmp-journal pattern.
 */

const TMP_DIR = `active/shared/tmp/ni01-tests-${process.pid}`;
let counter = 0;

function nextJournalPath(): string {
  counter += 1;
  return `${TMP_DIR}/agent-identities-${counter}.jsonl`;
}

function cleanupTmpDir(): void {
  const dir = pathResolver.rootResolve(TMP_DIR);
  if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
}

let previousMissionRole: string | undefined;
let previousPersona: string | undefined;
let previousTenant: string | undefined;
let currentJournalPath = '';

beforeEach(() => {
  previousMissionRole = process.env.MISSION_ROLE;
  previousPersona = process.env.KYBERION_PERSONA;
  previousTenant = process.env.KYBERION_TENANT;
  delete process.env.MISSION_ROLE;
  delete process.env.KYBERION_PERSONA;
  // D3: an NHI belongs to a tenant; the suite runs inside one active tenant.
  process.env.KYBERION_TENANT = 'demo-tenant';
  currentJournalPath = nextJournalPath();
  resetAgentIdentityServiceForTests(currentJournalPath);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousMissionRole;
  if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = previousPersona;
  if (previousTenant === undefined) delete process.env.KYBERION_TENANT;
  else process.env.KYBERION_TENANT = previousTenant;
  resetAgentIdentityServiceForTests();
});

afterAll(() => cleanupTmpDir());

function issueTestIdentity(slug = 'nerve-agent', overrides: Record<string, unknown> = {}) {
  return withExecutionContext('mission_controller', () =>
    issueAgentIdentity({
      kind: 'agent',
      organizationId: 'demo-org',
      slug,
      accountableHumanId: 'human:founder',
      ...overrides,
    } as Parameters<typeof issueAgentIdentity>[0])
  );
}

// ---------------------------------------------------------------------------
// nhi_id format: buildNhiId / parseNhiId / deriveAgentNhiId
// ---------------------------------------------------------------------------

describe('agent-identity — nhi_id format', () => {
  it('builds and parses the canonical URI round-trip', () => {
    const nhiId = buildNhiId('demo-tenant', 'demo-org', 'nerve-agent');
    expect(nhiId).toBe('kyberion://agent/demo-tenant/demo-org/nerve-agent');
    expect(parseNhiId(nhiId)).toEqual({
      tenant_slug: 'demo-tenant',
      organization_id: 'demo-org',
      slug: 'nerve-agent',
      legacy: false,
    });
  });

  it('rejects invalid slugs and orgs (agent-manifest agentId grammar)', () => {
    expect(() => buildNhiId('demo-tenant', 'demo-org', 'Bad_Slug')).toThrow(
      AgentIdentityFormatError
    );
    expect(() => buildNhiId('demo-tenant', 'demo-org', '1starts-with-digit')).toThrow(
      AgentIdentityFormatError
    );
    expect(() => buildNhiId('demo-tenant', 'Demo Org', 'ok-slug')).toThrow(
      AgentIdentityFormatError
    );
    expect(parseNhiId('kyberion://agent/demo-tenant/demo-org/Bad_Slug')).toBeNull();
    expect(parseNhiId('spiffe://other/thing')).toBeNull();
    expect(parseNhiId('stripe-prod')).toBeNull();
  });

  it('deriveAgentNhiId returns null for non-slug ids (e.g. service:stripe) instead of throwing', () => {
    expect(deriveAgentNhiId('service:stripe', 'demo-org')).toBeNull();
    expect(deriveAgentNhiId('nerve-agent', 'demo-org')).toBe(
      'kyberion://agent/demo-tenant/demo-org/nerve-agent'
    );
  });

  it('deriveAgentNhiId falls back to the tenant organization profile, then _ (never default)', () => {
    const derived = deriveAgentNhiId('nerve-agent');
    expect(derived).toBe('kyberion://agent/demo-tenant/_/nerve-agent');
  });

  it('deriveAgentNhiId is tenantless (org dropped) when no tenant is in scope', () => {
    delete process.env.KYBERION_TENANT;
    expect(deriveAgentNhiId('nerve-agent', 'demo-org')).toBe('kyberion://agent/_/_/nerve-agent');
    expect(deriveAgentNhiId('nerve-agent', 'demo-org', 'acme')).toBe(
      'kyberion://agent/acme/demo-org/nerve-agent'
    );
  });
});

// ---------------------------------------------------------------------------
// MO-11: organizationId threading — a tenant-scoped derivation must never
// collapse to the 'default' org (RUNTIME_NHI_ORGANIZATION_MISMATCH guard).
// ---------------------------------------------------------------------------

describe('agent-identity — deriveAgentNhiId organization threading', () => {
  it('derives a tenant-organization nhi_id, not the default fallback, when organizationId is supplied', () => {
    const nhiId = deriveAgentNhiId('tenant-worker', 'org-a');
    expect(nhiId).toBe('kyberion://agent/demo-tenant/org-a/tenant-worker');
    expect(nhiId).not.toContain('/default/');
  });

  it('still falls back to the tenant organization profile (else _) when organizationId is omitted', () => {
    const nhiId = deriveAgentNhiId('tenant-worker');
    expect(nhiId).toBe('kyberion://agent/demo-tenant/_/tenant-worker');
  });

  it('a tenant-organization-derived nhi_id satisfies assertRuntimeNhiScope for a scope in that same organization, and is rejected for another', () => {
    const record = issueTestIdentity('scope-checked-agent', { organizationId: 'org-a' });
    expect(record.nhi_id).toBe('kyberion://agent/demo-tenant/org-a/scope-checked-agent');

    const derivedNhiId = deriveAgentNhiId('scope-checked-agent', 'org-a');
    expect(derivedNhiId).toBe(record.nhi_id);

    expect(() =>
      assertRuntimeNhiScope({
        scope_kind: 'mission',
        tier: 'confidential',
        tenant_slug: 'demo-tenant',
        organization_id: 'org-a',
        mission_id: 'MSN-SCOPE-CHECK',
        nhi_id: derivedNhiId!,
      })
    ).not.toThrow();

    expect(() =>
      assertRuntimeNhiScope({
        scope_kind: 'mission',
        tier: 'confidential',
        tenant_slug: 'demo-tenant',
        organization_id: 'other-org',
        mission_id: 'MSN-SCOPE-CHECK',
        nhi_id: derivedNhiId!,
      })
    ).toThrow('[RUNTIME_NHI_ORGANIZATION_MISMATCH]');
  });
});

// ---------------------------------------------------------------------------
// Fail-closed governance gate (reads ungated)
// ---------------------------------------------------------------------------

describe('agent-identity — fail-closed execution-context gate', () => {
  it('issueAgentIdentity throws outside an allowlisted context, succeeds inside', () => {
    expect(() =>
      issueAgentIdentity({
        kind: 'agent',
        organizationId: 'demo-org',
        slug: 'gate-agent',
        accountableHumanId: 'human:founder',
      })
    ).toThrow(AgentIdentityGovernedError);

    const record = issueTestIdentity('gate-agent');
    expect(record.lifecycle_status).toBe('provisioned');
  });

  it('surface_runtime (agent runtime supervisor daemon role) is also allowlisted', () => {
    const record = withExecutionContext('surface_runtime', () =>
      issueAgentIdentity({
        kind: 'agent',
        organizationId: 'demo-org',
        slug: 'surface-agent',
        accountableHumanId: 'human:founder',
      })
    );
    expect(record.lifecycle_status).toBe('provisioned');
  });

  it('lifecycle mutations are gated too', () => {
    const record = issueTestIdentity('gated-lifecycle');
    expect(() => suspendAgentIdentity(record.nhi_id)).toThrow(AgentIdentityGovernedError);
    expect(() => retireAgentIdentity(record.nhi_id, 'test')).toThrow(AgentIdentityGovernedError);
    expect(() => bindRuntimeInstance({ nhiId: record.nhi_id, instanceId: 'inst-1' })).toThrow(
      AgentIdentityGovernedError
    );
    expect(() => releaseRuntimeInstance(record.nhi_id, 'inst-1')).toThrow(
      AgentIdentityGovernedError
    );
  });

  it('reads are exempt from the gate', () => {
    expect(() => getAgentIdentity('kyberion://agent/demo-tenant/demo-org/none')).not.toThrow();
    expect(getAgentIdentity('kyberion://agent/demo-tenant/demo-org/none')).toBeNull();
    expect(() => listAgentIdentities()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Accountable ownership fail-closed + slug validation + uniqueness
// ---------------------------------------------------------------------------

describe('agent-identity — accountable ownership and uniqueness', () => {
  it('revokes admitted sessions on accountability transfer without removing ordinary runtimes or identity provenance', () => {
    const issued = issueTestIdentity('transfer-session-agent');
    withExecutionContext('mission_controller', () => {
      bindRuntimeInstance({ nhiId: issued.nhi_id, instanceId: 'runtime-worker', pid: 4242 });
      bindRuntimeInstance({
        nhiId: issued.nhi_id,
        instanceId: 'nhi-session:old-owner',
        sessionId: 'kns1.old',
      });
      const unchanged = getAgentIdentity(issued.nhi_id);
      new AgentIdentityJournal({ journalPath: currentJournalPath }).append(
        AGENT_IDENTITY_OPS.accountabilityReassigned,
        {
          nhi_id: issued.nhi_id,
          previous_accountable_human_id: 'human:founder',
          accountable_human_id: 'human:founder',
          reason: 'same owner',
          reassigned_at: new Date().toISOString(),
        }
      );
      expect(getAgentIdentity(issued.nhi_id)).toEqual(unchanged);
      reassignAgentIdentityAccountability({
        nhiId: issued.nhi_id,
        expectedAccountableHumanId: 'human:founder',
        accountableHumanId: 'human:next',
        reason: 'transfer',
      });
      expect(getAgentIdentity(issued.nhi_id)?.runtime_instances).toEqual([
        expect.objectContaining({ instance_id: 'runtime-worker', pid: 4242 }),
      ]);
      reassignAgentIdentityAccountability({
        nhiId: issued.nhi_id,
        expectedAccountableHumanId: 'human:next',
        accountableHumanId: 'human:founder',
        reason: 'transfer back',
      });
    });
    const restored = new AgentIdentityJournal({ journalPath: currentJournalPath }).restore()
      .identities[issued.nhi_id];
    expect(restored).toMatchObject({
      nhi_id: issued.nhi_id,
      created_at: issued.created_at,
      affiliation: issued.affiliation,
      accountable_human_id: issued.accountable_human_id,
      lifecycle_status: 'active',
    });
    expect(restored.runtime_instances).toEqual([
      expect.objectContaining({ instance_id: 'runtime-worker', pid: 4242 }),
    ]);
  });

  it('journals accountable transfers without changing identity/home and fences stale and retired transfers', () => {
    const original = issueTestIdentity('accountable-transfer', {
      accountableHumanId: 'user:owner',
      affiliation: { tenant_slug: 'acme' },
    });
    const before = getAgentIdentityRevision(original.nhi_id);
    const next = withExecutionContext('mission_controller', () =>
      reassignAgentIdentityAccountability({
        nhiId: original.nhi_id,
        accountableHumanId: 'user:alice',
        expectedAccountableHumanId: 'user:owner',
        reason: 'Owner handover',
      })
    );
    expect(next.nhi_id).toBe(original.nhi_id);
    expect(next.affiliation).toEqual(original.affiliation);
    expect(next.accountable_human_id).toBe('user:alice');
    expect(getAgentIdentityRevision(original.nhi_id)).toBeGreaterThan(before);
    expect(() =>
      withExecutionContext('mission_controller', () =>
        reassignAgentIdentityAccountability({
          nhiId: original.nhi_id,
          accountableHumanId: 'user:carol',
          expectedAccountableHumanId: 'user:owner',
          reason: 'Stale',
        })
      )
    ).toThrow(AgentIdentityConflictError);
    resetAgentIdentityServiceForTests(currentJournalPath);
    expect(getAgentIdentity(original.nhi_id)?.accountable_human_id).toBe('user:alice');
    withExecutionContext('mission_controller', () =>
      retireAgentIdentity(original.nhi_id, 'Offboard')
    );
    expect(() =>
      withExecutionContext('mission_controller', () =>
        reassignAgentIdentityAccountability({
          nhiId: original.nhi_id,
          accountableHumanId: 'user:owner',
          expectedAccountableHumanId: 'user:alice',
          reason: 'Too late',
        })
      )
    ).toThrow(AgentIdentityLifecycleError);
  });
  it('agent issuance without accountable_human_id fails closed', () => {
    expect(() =>
      withExecutionContext('mission_controller', () =>
        issueAgentIdentity({
          kind: 'agent',
          organizationId: 'demo-org',
          slug: 'unowned-agent',
          accountableHumanId: '',
        })
      )
    ).toThrow(AgentIdentityAccountabilityError);
    expect(getAgentIdentity('kyberion://agent/demo-tenant/demo-org/unowned-agent')).toBeNull();
  });

  it('service issuance without accountable_human_id fails closed', () => {
    expect(() =>
      withExecutionContext('mission_controller', () =>
        issueAgentIdentity({
          kind: 'service',
          organizationId: 'demo-org',
          slug: 'unowned-service',
          accountableHumanId: '   ',
        })
      )
    ).toThrow(AgentIdentityAccountabilityError);
  });

  it('ensureAgentIdentityProvisioned defaults accountable_human_id to the owner member (user:owner) when the caller omits one and the organization profile is still the legacy human:operator default', () => {
    const record = withExecutionContext('mission_controller', () =>
      ensureAgentIdentityProvisioned({
        slug: 'owner-default-agent',
        organizationId: 'demo-org',
      })
    );
    expect(record.accountable_human_id).toBe('user:owner');
  });

  it('ensureAgentIdentityProvisioned keeps an explicitly provided accountable_human_id', () => {
    const record = withExecutionContext('mission_controller', () =>
      ensureAgentIdentityProvisioned({
        slug: 'explicit-owner-agent',
        organizationId: 'demo-org',
        accountableHumanId: 'human:founder',
      })
    );
    expect(record.accountable_human_id).toBe('human:founder');
  });

  it('slug format is validated at issuance', () => {
    expect(() =>
      withExecutionContext('mission_controller', () =>
        issueAgentIdentity({
          kind: 'agent',
          organizationId: 'demo-org',
          slug: 'Bad_Slug',
          accountableHumanId: 'human:founder',
        })
      )
    ).toThrow(AgentIdentityFormatError);
  });

  it('ensure preserves history but rejects explicit tenant and accountability conflicts', () => {
    const record = issueTestIdentity('bounded-agent', {
      affiliation: { tenant_slug: 'company-a' },
    });
    expect(record.nhi_id).toBe('kyberion://agent/company-a/demo-org/bounded-agent');
    const parameters = {
      slug: 'bounded-agent',
      organizationId: 'demo-org',
      affiliation: { tenant_slug: 'company-a' },
    };
    // D3: the tenant is part of the id, so an explicit tenant that disagrees
    // with the requested one is a conflict, never a silent re-affiliation.
    expect(() =>
      ensureAgentIdentityProvisioned({ ...parameters, tenantSlug: 'company-b' })
    ).toThrow(AgentIdentityFormatError);
    expect(() =>
      ensureAgentIdentityProvisioned({ ...parameters, accountableHumanId: 'user:someone-else' })
    ).toThrow(AgentIdentityConflictError);
    expect(getAgentIdentity(record.nhi_id)).toEqual(record);
  });

  it.each(['suspend', 'retire'] as const)(
    'ensure does not resurrect or stamp a known %s identity',
    (operation) => {
      const record = issueTestIdentity('revoked-agent');
      withExecutionContext('mission_controller', () =>
        operation === 'suspend'
          ? suspendAgentIdentity(record.nhi_id)
          : retireAgentIdentity(record.nhi_id, 'synthetic test')
      );
      const parameters = { slug: 'revoked-agent', organizationId: 'demo-org' };
      expect(() => ensureAgentIdentityProvisioned(parameters)).toThrow(AgentIdentityConflictError);
      expect(ensureAgentIdentityBestEffort(parameters)).toEqual({
        nhi_id: null,
        record: null,
        recorded: false,
      });
      expect(getAgentIdentity(record.nhi_id)?.lifecycle_status).toBe(
        operation === 'suspend' ? 'suspended' : 'retired'
      );
    }
  );

  it('persists canonical tenant affiliation separately from the organization id', () => {
    const record = issueTestIdentity('tenant-affiliated-agent', {
      affiliation: { tenant_slug: 'acme-corp', project_id: 'project-x' },
    });
    expect(record.affiliation).toEqual({
      organization_id: 'demo-org',
      tenant_slug: 'acme-corp',
      project_id: 'project-x',
    });
  });

  it('rejects a reserved tenant affiliation slug', () => {
    expect(() =>
      issueTestIdentity('reserved-tenant-agent', {
        affiliation: { tenant_slug: 'confidential' },
      })
    ).toThrow(AgentIdentityFormatError);
  });

  it('re-issue with identical core params is idempotent; differing params conflict', () => {
    const first = issueTestIdentity('unique-agent');
    const second = issueTestIdentity('unique-agent');
    expect(second).toEqual(first);

    expect(() => issueTestIdentity('unique-agent', { accountableHumanId: 'human:other' })).toThrow(
      AgentIdentityConflictError
    );
  });

  it('a retired nhi_id is never re-issued (no NHI reuse)', () => {
    const record = issueTestIdentity('reuse-agent');
    withExecutionContext('mission_controller', () =>
      retireAgentIdentity(record.nhi_id, 'mission complete')
    );
    expect(() => issueTestIdentity('reuse-agent')).toThrow(AgentIdentityConflictError);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle journal replay: issue -> activate -> suspend -> retire
// ---------------------------------------------------------------------------

describe('agent-identity — lifecycle and restart replay', () => {
  it('initial activation never lifts suspension, including a delayed journal event', () => {
    const issued = issueTestIdentity('initial-consent-agent');
    withExecutionContext('mission_controller', () => {
      expect(activateProvisionedAgentIdentity(issued.nhi_id).lifecycle_status).toBe('active');
      suspendAgentIdentity(issued.nhi_id, 'human hold');
      expect(() => activateProvisionedAgentIdentity(issued.nhi_id)).toThrow('provisioned');
      new AgentIdentityJournal({ journalPath: currentJournalPath }).append(
        AGENT_IDENTITY_OPS.identityActivated,
        { nhi_id: issued.nhi_id, activated_at: new Date().toISOString(), only_provisioned: true }
      );
      expect(getAgentIdentity(issued.nhi_id)?.lifecycle_status).toBe('suspended');
    });
  });
  it('rejects an external journal path before reading or writing it', () => {
    expect(
      () => new AgentIdentityJournal({ journalPath: '/tmp/agent-identity-external.jsonl' })
    ).toThrow('RESOURCE_PATH_SCOPE');
  });

  it('fails closed when the identity journal is replaced by a directory', () => {
    const journalPath = nextJournalPath();
    const resolvedJournalPath = pathResolver.rootResolve(journalPath);
    safeMkdir(resolvedJournalPath, { recursive: true });

    expect(() => new AgentIdentityJournal({ journalPath }).restore()).toThrow(
      'journal must be a regular file'
    );
  });

  it('issue -> activate -> suspend -> retire, with fresh replay seeing the same state at every step', () => {
    const issued = issueTestIdentity('lifecycle-agent', {
      displayName: 'Lifecycle Agent',
      affiliation: { mission_id: 'MSN-NI01-001' },
      providerHint: 'claude',
      modelHint: 'claude-fable-5',
    });
    expect(issued.lifecycle_status).toBe('provisioned');
    expect(issued.affiliation).toEqual({
      organization_id: 'demo-org',
      tenant_slug: 'demo-tenant',
      mission_id: 'MSN-NI01-001',
    });
    expect(issued.created_at).toEqual(expect.any(String));

    const activated = withExecutionContext('mission_controller', () =>
      activateAgentIdentity(issued.nhi_id)
    );
    expect(activated.lifecycle_status).toBe('active');

    const suspended = withExecutionContext('mission_controller', () =>
      suspendAgentIdentity(issued.nhi_id, 'anomalous behavior')
    );
    expect(suspended.lifecycle_status).toBe('suspended');

    const retired = withExecutionContext('mission_controller', () =>
      retireAgentIdentity(issued.nhi_id, 'offboarded')
    );
    expect(retired.lifecycle_status).toBe('retired');
    expect(retired.retired_at).toEqual(expect.any(String));
    expect(retired.retire_reason).toBe('offboarded');

    // Module-reload equivalent: fresh in-process state pointed at the same
    // journal must see identical state (restart-transparent, SO-02 contract).
    resetAgentIdentityServiceForTests(currentJournalPath);
    const replayed = getAgentIdentity(issued.nhi_id);
    expect(replayed).toEqual(retired);

    // Two independent journal instances restore byte-identical state.
    const a = new AgentIdentityJournal({ journalPath: currentJournalPath }).restore();
    const b = new AgentIdentityJournal({ journalPath: currentJournalPath }).restore();
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('lifecycle transitions are idempotent and retired is terminal', () => {
    const issued = issueTestIdentity('idem-agent');
    const retired = withExecutionContext('mission_controller', () => {
      retireAgentIdentity(issued.nhi_id, 'first');
      return retireAgentIdentity(issued.nhi_id, 'second');
    });
    // Idempotent: the second retire returns the first retire's record.
    expect(retired.retire_reason).toBe('first');

    expect(() =>
      withExecutionContext('mission_controller', () => activateAgentIdentity(issued.nhi_id))
    ).toThrow(AgentIdentityLifecycleError);
    expect(() =>
      withExecutionContext('mission_controller', () => suspendAgentIdentity(issued.nhi_id))
    ).toThrow(AgentIdentityLifecycleError);
  });

  it('mutating an unknown identity throws AgentIdentityNotFoundError', () => {
    expect(() =>
      withExecutionContext('mission_controller', () =>
        retireAgentIdentity('kyberion://agent/demo-tenant/demo-org/ghost', 'nope')
      )
    ).toThrow(AgentIdentityNotFoundError);
  });

  it('replay tolerates corrupt journal lines', () => {
    const journal = new AgentIdentityJournal({ journalPath: currentJournalPath });
    journal.append(AGENT_IDENTITY_OPS.identityProvisioned, {
      nhi_id: 'kyberion://agent/demo-tenant/demo-org/corrupt-test',
      kind: 'agent',
      display_name: 'corrupt-test',
      accountable_human_id: 'human:founder',
      affiliation: { organization_id: 'demo-org' },
      created_at: '2026-07-26T00:00:00.000Z',
    });
    // Torn/corrupt lines between valid events.
    const absolutePath = pathResolver.rootResolve(currentJournalPath);
    safeAppendFileSync(absolutePath, 'this is not json\n');
    safeAppendFileSync(absolutePath, '{"v":1,"seq":"not-a-number"}\n');
    journal.append(AGENT_IDENTITY_OPS.identityActivated, {
      nhi_id: 'kyberion://agent/demo-tenant/demo-org/corrupt-test',
      activated_at: '2026-07-26T00:01:00.000Z',
    });

    const restored = new AgentIdentityJournal({ journalPath: currentJournalPath }).restore();
    const record = restored.identities['kyberion://agent/demo-tenant/demo-org/corrupt-test'];
    expect(record).toBeDefined();
    expect(record.lifecycle_status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Runtime instance binding (agent-registry is the runtime-instance cache)
// ---------------------------------------------------------------------------

describe('agent-identity — runtime instance binding', () => {
  it.each(['suspend', 'suspend-reactivate', 'retire'] as const)(
    'fences a %s between the binding precheck and writer-lease acquisition',
    (interruption) => {
      const issued = issueTestIdentity('interrupted-binding');
      const original = writerLease.withFencedWriterLeaseSync;
      const spy = vi
        .spyOn(writerLease, 'withFencedWriterLeaseSync')
        .mockImplementationOnce((options) => {
          spy.mockRestore();
          withExecutionContext('mission_controller', () => {
            if (interruption === 'retire') retireAgentIdentity(issued.nhi_id, 'incident');
            else {
              suspendAgentIdentity(issued.nhi_id, 'incident');
              if (interruption === 'suspend-reactivate') activateAgentIdentity(issued.nhi_id);
            }
          });
          return original(options);
        });
      expect(() =>
        withExecutionContext('mission_controller', () =>
          bindRuntimeInstance({
            nhiId: issued.nhi_id,
            instanceId: 'nhi-session:late',
            sessionId: 'kns1.late',
          })
        )
      ).toThrow('identity changed before binding');
      const restored = new AgentIdentityJournal({ journalPath: currentJournalPath }).restore();
      expect(restored.identities[issued.nhi_id].lifecycle_status).toBe(
        interruption === 'retire' ? 'retired' : interruption === 'suspend' ? 'suspended' : 'active'
      );
      expect(restored.identities[issued.nhi_id].runtime_instances).toBeUndefined();
    }
  );

  it('ignores a delayed bind event while suspended, even after reactivation and replay', () => {
    const issued = issueTestIdentity('delayed-binding');
    withExecutionContext('mission_controller', () => {
      suspendAgentIdentity(issued.nhi_id, 'incident');
      new AgentIdentityJournal({ journalPath: currentJournalPath }).append(
        AGENT_IDENTITY_OPS.instanceBound,
        {
          nhi_id: issued.nhi_id,
          instance_id: 'nhi-session:late',
          session_id: 'kns1.late',
          bound_at: new Date().toISOString(),
          activate_provisioned: true,
        }
      );
      activateAgentIdentity(issued.nhi_id);
    });
    expect(getAgentIdentity(issued.nhi_id)?.runtime_instances).toBeUndefined();
  });

  it('allocates monotonic sequences for alternating journal writers', () => {
    const issued = issueTestIdentity('multi-writer');
    const first = new AgentIdentityJournal({ journalPath: currentJournalPath });
    const second = new AgentIdentityJournal({ journalPath: currentJournalPath });
    first.restore();
    second.restore();
    withExecutionContext('mission_controller', () => {
      const a = first.append(AGENT_IDENTITY_OPS.identityActivated, {
        nhi_id: issued.nhi_id,
        activated_at: new Date().toISOString(),
      });
      const b = second.append(AGENT_IDENTITY_OPS.identitySuspended, {
        nhi_id: issued.nhi_id,
        suspended_at: new Date().toISOString(),
      });
      const c = first.append(AGENT_IDENTITY_OPS.identityActivated, {
        nhi_id: issued.nhi_id,
        activated_at: new Date().toISOString(),
      });
      expect([b.seq, c.seq]).toEqual([a.seq + 1, a.seq + 2]);
      expect(getAgentIdentityRevision(issued.nhi_id)).toBe(c.seq);
    });
  });

  it('binding an instance activates a provisioned identity and records the instance', () => {
    const issued = issueTestIdentity('instance-agent');
    const bound = withExecutionContext('mission_controller', () =>
      bindRuntimeInstance({
        nhiId: issued.nhi_id,
        instanceId: 'instance-agent',
        pid: 4242,
        sessionId: 'MSN-NI01-002',
        provider: 'claude',
        modelId: 'claude-fable-5',
      })
    );
    expect(bound.lifecycle_status).toBe('active');
    expect(bound.runtime_instances).toHaveLength(1);
    expect(bound.runtime_instances?.[0]).toMatchObject({
      instance_id: 'instance-agent',
      pid: 4242,
      session_id: 'MSN-NI01-002',
    });
  });

  it('releasing an instance keeps the identity active (retire is explicit)', () => {
    const issued = issueTestIdentity('release-agent');
    withExecutionContext('mission_controller', () =>
      bindRuntimeInstance({ nhiId: issued.nhi_id, instanceId: 'release-agent' })
    );
    const released = withExecutionContext('mission_controller', () =>
      releaseRuntimeInstance(issued.nhi_id, 'release-agent', 'shutdown')
    );
    expect(released?.lifecycle_status).toBe('active');
    expect(released?.runtime_instances).toBeUndefined();
  });

  it('releasing an unknown instance or identity is an idempotent no-op', () => {
    const issued = issueTestIdentity('noop-agent');
    const sameRecord = withExecutionContext('mission_controller', () =>
      releaseRuntimeInstance(issued.nhi_id, 'never-bound')
    );
    expect(sameRecord).toEqual(issued);
    const unknown = withExecutionContext('mission_controller', () =>
      releaseRuntimeInstance('kyberion://agent/demo-tenant/demo-org/ghost', 'anything')
    );
    expect(unknown).toBeNull();
  });

  it('binding to a suspended or retired identity fails closed', () => {
    const issued = issueTestIdentity('blocked-agent');
    withExecutionContext('mission_controller', () => suspendAgentIdentity(issued.nhi_id));
    expect(() =>
      withExecutionContext('mission_controller', () =>
        bindRuntimeInstance({ nhiId: issued.nhi_id, instanceId: 'inst' })
      )
    ).toThrow(AgentIdentityLifecycleError);

    withExecutionContext('mission_controller', () => retireAgentIdentity(issued.nhi_id, 'done'));
    expect(() =>
      withExecutionContext('mission_controller', () =>
        bindRuntimeInstance({ nhiId: issued.nhi_id, instanceId: 'inst' })
      )
    ).toThrow(AgentIdentityLifecycleError);
  });
});

// ---------------------------------------------------------------------------
// listAgentIdentities filters + best-effort seam
// ---------------------------------------------------------------------------

describe('agent-identity — listing and best-effort helpers', () => {
  it('filters by kind, lifecycle status, org, mission, and accountable human', () => {
    issueTestIdentity('list-agent-a', { affiliation: { mission_id: 'MSN-LIST-1' } });
    issueTestIdentity('list-agent-b', { accountableHumanId: 'human:other' });
    withExecutionContext('mission_controller', () =>
      issueAgentIdentity({
        kind: 'service',
        organizationId: 'other-org',
        slug: 'list-service',
        accountableHumanId: 'human:founder',
      })
    );

    expect(listAgentIdentities()).toHaveLength(3);
    expect(listAgentIdentities({ kind: 'service' }).map((r) => r.nhi_id)).toEqual([
      'kyberion://agent/demo-tenant/other-org/list-service',
    ]);
    expect(listAgentIdentities({ organization_id: 'demo-org' })).toHaveLength(2);
    expect(listAgentIdentities({ mission_id: 'MSN-LIST-1' }).map((r) => r.nhi_id)).toEqual([
      'kyberion://agent/demo-tenant/demo-org/list-agent-a',
    ]);
    expect(listAgentIdentities({ accountable_human_id: 'human:other' })).toHaveLength(1);
    expect(listAgentIdentities({ lifecycle_status: 'provisioned' })).toHaveLength(3);
  });

  it('ensureAgentIdentityBestEffort outside an allowlisted context still derives the nhi_id but records nothing', () => {
    const result = ensureAgentIdentityBestEffort({
      slug: 'best-effort-agent',
      organizationId: 'demo-org',
      accountableHumanId: 'human:founder',
    });
    expect(result.nhi_id).toBe('kyberion://agent/demo-tenant/demo-org/best-effort-agent');
    expect(result.recorded).toBe(false);
    expect(getAgentIdentity(result.nhi_id!)).toBeNull();
  });

  it('ensureAgentIdentityBestEffort inside an allowlisted context issues a provisioned record', () => {
    const result = withExecutionContext('mission_controller', () =>
      ensureAgentIdentityBestEffort({
        slug: 'best-effort-recorded',
        organizationId: 'demo-org',
        accountableHumanId: 'human:founder',
      })
    );
    expect(result.recorded).toBe(true);
    expect(result.record?.lifecycle_status).toBe('provisioned');
    expect(
      getAgentIdentity('kyberion://agent/demo-tenant/demo-org/best-effort-recorded')
    ).not.toBeNull();
  });

  it('ensureAgentIdentityBestEffort returns null nhi_id for an invalid slug', () => {
    const result = ensureAgentIdentityBestEffort({ slug: 'service:stripe' });
    expect(result.nhi_id).toBeNull();
    expect(result.recorded).toBe(false);
  });

  it('refuses writes to the governed default journal path under vitest (hermetic-test guard)', () => {
    resetAgentIdentityServiceForTests(); // back on the governed default path
    expect(() =>
      withExecutionContext('mission_controller', () =>
        issueAgentIdentity({
          kind: 'agent',
          organizationId: 'demo-org',
          slug: 'default-path-agent',
          accountableHumanId: 'human:founder',
        })
      )
    ).toThrow(/refusing to write the governed default journal under vitest/);
  });
});

// Historical binding metadata is deliberately separate from live authorization.
describe('runtime binding history references', () => {
  function fixture(slug = 'history-agent') {
    const identity = issueTestIdentity(slug, { affiliation: { tenant_slug: 'fixture-a' } });
    const input = {
      nhiId: identity.nhi_id,
      instanceId: 'runtime-fixture',
      sessionId: 'synthetic-session-secret',
      tenantSlug: 'fixture-a',
    };
    withExecutionContext('mission_controller', () => bindRuntimeInstance(input));
    const journal = new AgentIdentityJournal({ journalPath: currentJournalPath });
    const reference = journal.captureRuntimeBindingReference(input)!;
    expect(reference).toBeDefined();
    return { identity, input, journal, reference };
  }

  it('keeps historical identity/accountability after release, reassignment and retirement without secrets', () => {
    const { identity, input, journal, reference } = fixture();
    const original = journal.resolveRuntimeBindingReference(reference, 'fixture-a');
    expect(original).toMatchObject({
      assurance: 'metadata_only',
      nhi_id: identity.nhi_id,
      accountable_human_id: 'human:founder',
      instance_id: input.instanceId,
    });
    expect(JSON.stringify({ reference, original })).not.toContain(input.sessionId);
    expect(original).not.toHaveProperty('session_id');
    withExecutionContext('mission_controller', () => {
      releaseRuntimeInstance(identity.nhi_id, input.instanceId);
      reassignAgentIdentityAccountability({
        nhiId: identity.nhi_id,
        expectedAccountableHumanId: 'human:founder',
        accountableHumanId: 'human:next',
        reason: 'fixture',
      });
      retireAgentIdentity(identity.nhi_id, 'fixture');
    });
    expect(journal.captureRuntimeBindingReference(input)).toBeUndefined();
    expect(
      new AgentIdentityJournal({ journalPath: currentJournalPath }).resolveRuntimeBindingReference(
        reference,
        'fixture-a'
      )
    ).toEqual(original);
  });

  it('distinguishes rebindings and distinct NHIs sharing an accountable human', () => {
    const first = fixture();
    const original = first.journal.resolveRuntimeBindingReference(first.reference, 'fixture-a');
    const replacement = { ...first.input, sessionId: 'new-synthetic-secret' };
    withExecutionContext('mission_controller', () => bindRuntimeInstance(replacement));
    const next = first.journal.captureRuntimeBindingReference(replacement)!;
    expect(next.journal_seq).toBeGreaterThan(first.reference.journal_seq);
    expect(next.sha256).not.toBe(first.reference.sha256);
    expect(first.journal.captureRuntimeBindingReference(first.input)).toBeUndefined();
    expect(first.journal.resolveRuntimeBindingReference(first.reference, 'fixture-a')).toEqual(
      original
    );
    const second = fixture('another-history-agent');
    expect(second.reference.nhi_id).not.toBe(first.reference.nhi_id);
    expect(
      second.journal.resolveRuntimeBindingReference(second.reference, 'fixture-a')
        ?.accountable_human_id
    ).toBe(original?.accountable_human_id);
  });

  it('rejects foreign scope, NHI, sequence, malformed reference and fingerprint mismatch', () => {
    const { journal, reference, input } = fixture();
    expect(journal.resolveRuntimeBindingReference(reference, 'fixture-b')).toBeUndefined();
    for (const changes of [
      { nhi_id: 'kyberion://agent/demo-tenant/demo-org/foreign' },
      { journal_seq: 0 },
      { journal_seq: -1 },
      { journal_seq: 1.5 },
      { journal_seq: Number.MAX_SAFE_INTEGER + 1 },
      { sha256: '0'.repeat(64) },
      { version: 2 },
      { extra: true },
    ])
      expect(
        journal.resolveRuntimeBindingReference(
          { ...reference, ...changes } as typeof reference,
          'fixture-a'
        )
      ).toBeUndefined();
    expect(
      journal.captureRuntimeBindingReference({ ...input, sessionId: 'wrong' })
    ).toBeUndefined();
    expect(
      journal.captureRuntimeBindingReference({ ...input, tenantSlug: 'fixture-b' })
    ).toBeUndefined();
  });

  it.each([
    'malformed',
    'unknown-op',
    'invalid-payload',
    'duplicate',
    'gap',
    'version',
    'unsafe-seq',
  ])('refuses %s history without changing tolerant restore or leaking input', (defect) => {
    const { journal, reference, identity } = fixture();
    const next = reference.journal_seq + 1;
    const event = {
      v: defect === 'version' ? 2 : 1,
      seq:
        defect === 'duplicate'
          ? reference.journal_seq
          : defect === 'gap'
            ? next + 1
            : defect === 'unsafe-seq'
              ? Number.MAX_SAFE_INTEGER + 1
              : next,
      ts: '2026-11-04T00:00:00.000Z',
      op: defect === 'unknown-op' ? 'unknown' : AGENT_IDENTITY_OPS.identityActivated,
      payload:
        defect === 'invalid-payload'
          ? { session_id: 'must-not-leak' }
          : { nhi_id: identity.nhi_id, activated_at: '2026-11-04T00:00:00.000Z' },
    };
    safeAppendFileSync(
      pathResolver.rootResolve(currentJournalPath),
      defect === 'malformed' ? '{"session_id":"must-not-leak"\n' : `${JSON.stringify(event)}\n`
    );
    expect(() => journal.resolveRuntimeBindingReference(reference, 'fixture-a')).toThrow(
      '[RUNTIME_BINDING_HISTORY] journal history unavailable'
    );
    expect(() => journal.restore()).not.toThrow();
  });

  it('does not project a no-op bind on a suspended identity into historical metadata', () => {
    const { journal, input, reference } = fixture();
    withExecutionContext('mission_controller', () => suspendAgentIdentity(input.nhiId, 'fixture'));
    const ignored = journal.append(AGENT_IDENTITY_OPS.instanceBound, {
      nhi_id: input.nhiId,
      instance_id: input.instanceId,
      tenant_slug: input.tenantSlug,
      bound_at: '2026-11-04T00:00:00.000Z',
      session_id: input.sessionId,
    });
    expect(journal.captureRuntimeBindingReference(input)).toBeUndefined();
    expect(
      journal.resolveRuntimeBindingReference(
        { ...reference, journal_seq: ignored.seq },
        'fixture-a'
      )
    ).toBeUndefined();
  });
});

it('keeps the original effective reference across a redundant same-content bind', () => {
  const identity = issueTestIdentity('redundant-binding', {
    affiliation: { tenant_slug: 'fixture-a' },
  });
  const input = {
    nhiId: identity.nhi_id,
    instanceId: 'runtime-fixture',
    sessionId: 'synthetic-secret',
    tenantSlug: 'fixture-a',
  };
  const record = withExecutionContext('mission_controller', () => bindRuntimeInstance(input));
  const journal = new AgentIdentityJournal({ journalPath: currentJournalPath });
  const reference = journal.captureRuntimeBindingReference(input)!;
  withExecutionContext('mission_controller', () =>
    reassignAgentIdentityAccountability({
      nhiId: identity.nhi_id,
      expectedAccountableHumanId: 'human:founder',
      accountableHumanId: 'human:next',
      reason: 'fixture',
    })
  );
  const duplicate = journal.append(AGENT_IDENTITY_OPS.instanceBound, {
    nhi_id: input.nhiId,
    ...record.runtime_instances![0],
  });
  expect(journal.captureRuntimeBindingReference(input)).toEqual(reference);
  expect(journal.resolveRuntimeBindingReference(reference, 'fixture-a')?.accountable_human_id).toBe(
    'human:founder'
  );
  expect(
    journal.resolveRuntimeBindingReference(
      { ...reference, journal_seq: duplicate.seq },
      'fixture-a'
    )
  ).toBeUndefined();
});

it('does not fall back to an old reference when a newer effective binding has invalid metadata', () => {
  const identity = issueTestIdentity('invalid-current-history', {
    affiliation: { tenant_slug: 'fixture-a' },
  });
  const input = {
    nhiId: identity.nhi_id,
    instanceId: 'runtime-fixture',
    sessionId: 'synthetic-secret',
    tenantSlug: 'fixture-a',
  };
  const record = withExecutionContext('mission_controller', () => bindRuntimeInstance(input));
  const journal = new AgentIdentityJournal({ journalPath: currentJournalPath });
  const reference = journal.captureRuntimeBindingReference(input)!;
  journal.append(AGENT_IDENTITY_OPS.instanceBound, {
    nhi_id: input.nhiId,
    ...record.runtime_instances![0],
    expires_at: 'invalid-date',
  });
  expect(journal.captureRuntimeBindingReference(input)).toBeUndefined();
  expect(journal.resolveRuntimeBindingReference(reference, 'fixture-a')).toBeDefined();
});
