import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeExistsSync, safeRmSync } from './secure-io.js';
import { withExecutionContext } from './authority.js';
import {
  activateAgentIdentity,
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
  getAgentIdentity,
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
let currentJournalPath = '';

beforeEach(() => {
  previousMissionRole = process.env.MISSION_ROLE;
  previousPersona = process.env.KYBERION_PERSONA;
  delete process.env.MISSION_ROLE;
  delete process.env.KYBERION_PERSONA;
  currentJournalPath = nextJournalPath();
  resetAgentIdentityServiceForTests(currentJournalPath);
});

afterEach(() => {
  if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousMissionRole;
  if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = previousPersona;
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
    const nhiId = buildNhiId('demo-org', 'nerve-agent');
    expect(nhiId).toBe('kyberion://agent/demo-org/nerve-agent');
    expect(parseNhiId(nhiId)).toEqual({ organization_id: 'demo-org', slug: 'nerve-agent' });
  });

  it('rejects invalid slugs and orgs (agent-manifest agentId grammar)', () => {
    expect(() => buildNhiId('demo-org', 'Bad_Slug')).toThrow(AgentIdentityFormatError);
    expect(() => buildNhiId('demo-org', '1starts-with-digit')).toThrow(AgentIdentityFormatError);
    expect(() => buildNhiId('Demo Org', 'ok-slug')).toThrow(AgentIdentityFormatError);
    expect(parseNhiId('kyberion://agent/demo-org/Bad_Slug')).toBeNull();
    expect(parseNhiId('spiffe://other/thing')).toBeNull();
    expect(parseNhiId('stripe-prod')).toBeNull();
  });

  it('deriveAgentNhiId returns null for non-slug ids (e.g. service:stripe) instead of throwing', () => {
    expect(deriveAgentNhiId('service:stripe', 'demo-org')).toBeNull();
    expect(deriveAgentNhiId('nerve-agent', 'demo-org')).toBe(
      'kyberion://agent/demo-org/nerve-agent'
    );
  });

  it('deriveAgentNhiId falls back to the organization profile org, then default', () => {
    const derived = deriveAgentNhiId('nerve-agent');
    expect(derived).toMatch(/^kyberion:\/\/agent\/[a-z][a-z0-9-]*\/nerve-agent$/);
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
    expect(() => getAgentIdentity('kyberion://agent/demo-org/none')).not.toThrow();
    expect(getAgentIdentity('kyberion://agent/demo-org/none')).toBeNull();
    expect(() => listAgentIdentities()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Accountable ownership fail-closed + slug validation + uniqueness
// ---------------------------------------------------------------------------

describe('agent-identity — accountable ownership and uniqueness', () => {
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
    expect(getAgentIdentity('kyberion://agent/demo-org/unowned-agent')).toBeNull();
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
        retireAgentIdentity('kyberion://agent/demo-org/ghost', 'nope')
      )
    ).toThrow(AgentIdentityNotFoundError);
  });

  it('replay tolerates corrupt journal lines', () => {
    const journal = new AgentIdentityJournal({ journalPath: currentJournalPath });
    journal.append(AGENT_IDENTITY_OPS.identityProvisioned, {
      nhi_id: 'kyberion://agent/demo-org/corrupt-test',
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
      nhi_id: 'kyberion://agent/demo-org/corrupt-test',
      activated_at: '2026-07-26T00:01:00.000Z',
    });

    const restored = new AgentIdentityJournal({ journalPath: currentJournalPath }).restore();
    const record = restored.identities['kyberion://agent/demo-org/corrupt-test'];
    expect(record).toBeDefined();
    expect(record.lifecycle_status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Runtime instance binding (agent-registry is the runtime-instance cache)
// ---------------------------------------------------------------------------

describe('agent-identity — runtime instance binding', () => {
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
      releaseRuntimeInstance('kyberion://agent/demo-org/ghost', 'anything')
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
      'kyberion://agent/other-org/list-service',
    ]);
    expect(listAgentIdentities({ organization_id: 'demo-org' })).toHaveLength(2);
    expect(listAgentIdentities({ mission_id: 'MSN-LIST-1' }).map((r) => r.nhi_id)).toEqual([
      'kyberion://agent/demo-org/list-agent-a',
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
    expect(result.nhi_id).toBe('kyberion://agent/demo-org/best-effort-agent');
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
    expect(getAgentIdentity('kyberion://agent/demo-org/best-effort-recorded')).not.toBeNull();
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
