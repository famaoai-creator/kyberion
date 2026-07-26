import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeRmSync } from './secure-io.js';
import { withExecutionContext } from './authority.js';
import {
  issueAgentIdentity,
  activateAgentIdentity,
  retireAgentIdentity,
  suspendAgentIdentity,
  resetAgentIdentityServiceForTests,
} from './agent-identity.js';
import {
  clearNhiActorVerificationCache,
  enforceNhiActorPolicy,
  NHI_ACTOR_INACTIVE_EVENT,
  NHI_ACTOR_UNREGISTERED_EVENT,
  NhiActorPolicyError,
  resolveNhiActorMode,
  setNhiActorAuditSinkForTests,
  verifyNhiActor,
  type NhiActorAuditEvent,
} from './nhi-actor-verification.js';
import {
  claimWorkItem,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  handoffWorkItem,
  setWorkCoordinationNamespace,
} from './work-coordination.js';
import {
  createOrchestratorSession,
  resetOrchestratorSessionServiceForTests,
} from './orchestrator-session.js';

/**
 * NI-02 tests. Hermetic: the agent-identity journal, the orchestrator-session
 * journal, and the work-coordination namespace are all repointed to unique
 * per-test locations under active/shared/tmp/ (mirrors agent-identity.test.ts
 * and orchestrator-session.test.ts), and audit events are observed through an
 * injected sink (the seam's default sink is a no-op under vitest precisely
 * because the audit chain writes the real active/ tree).
 */

const TMP_DIR = `active/shared/tmp/ni02-tests-${process.pid}`;
let counter = 0;

function cleanupTmpDir(): void {
  const dir = pathResolver.rootResolve(TMP_DIR);
  if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
}

let previousMissionRole: string | undefined;
let previousPersona: string | undefined;
let previousActorMode: string | undefined;
let auditEvents: NhiActorAuditEvent[] = [];

beforeEach(() => {
  counter += 1;
  previousMissionRole = process.env.MISSION_ROLE;
  previousPersona = process.env.KYBERION_PERSONA;
  previousActorMode = process.env.KYBERION_NHI_ACTOR;
  delete process.env.MISSION_ROLE;
  delete process.env.KYBERION_PERSONA;
  delete process.env.KYBERION_NHI_ACTOR;
  resetAgentIdentityServiceForTests(`${TMP_DIR}/agent-identities-${counter}.jsonl`);
  resetOrchestratorSessionServiceForTests(`${TMP_DIR}/orchestrator-sessions-${counter}.jsonl`);
  setWorkCoordinationNamespace(`nhi-actor-ni02-tests-${process.pid}-${counter}`);
  clearWorkCoordinationStore();
  clearNhiActorVerificationCache();
  auditEvents = [];
  setNhiActorAuditSinkForTests((event) => auditEvents.push(event));
});

afterEach(() => {
  if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousMissionRole;
  if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = previousPersona;
  if (previousActorMode === undefined) delete process.env.KYBERION_NHI_ACTOR;
  else process.env.KYBERION_NHI_ACTOR = previousActorMode;
  setNhiActorAuditSinkForTests(null);
  clearNhiActorVerificationCache();
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
  resetAgentIdentityServiceForTests();
  resetOrchestratorSessionServiceForTests();
});

afterAll(() => cleanupTmpDir());

function issueTestIdentity(slug: string) {
  return withExecutionContext('mission_controller', () =>
    issueAgentIdentity({
      kind: 'agent',
      organizationId: 'ni02-org',
      slug,
      accountableHumanId: 'human:founder',
    })
  );
}

// ---------------------------------------------------------------------------
// resolveNhiActorMode
// ---------------------------------------------------------------------------

describe('nhi-actor-verification — mode resolution', () => {
  it('defaults to warn; honors off/enforce; degrades garbage to warn', () => {
    expect(resolveNhiActorMode()).toBe('warn');
    process.env.KYBERION_NHI_ACTOR = 'off';
    expect(resolveNhiActorMode()).toBe('off');
    process.env.KYBERION_NHI_ACTOR = 'enforce';
    expect(resolveNhiActorMode()).toBe('enforce');
    process.env.KYBERION_NHI_ACTOR = 'garbage';
    expect(resolveNhiActorMode()).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// verifyNhiActor
// ---------------------------------------------------------------------------

describe('nhi-actor-verification — verifyNhiActor', () => {
  it('classifies blank and grammar-invalid nhi URIs as malformed', () => {
    expect(verifyNhiActor('')).toEqual({ verdict: 'malformed' });
    expect(verifyNhiActor('   ')).toEqual({ verdict: 'malformed' });
    expect(verifyNhiActor('kyberion://agent/ni02-org/Bad_Slug')).toEqual({
      verdict: 'malformed',
    });
    expect(verifyNhiActor('kyberion://agent/only-org')).toEqual({ verdict: 'malformed' });
  });

  it('classifies legacy non-nhi actor strings as unregistered without an nhi_id', () => {
    expect(verifyNhiActor('orchestrator')).toEqual({ verdict: 'unregistered' });
    expect(verifyNhiActor('user:U12345')).toEqual({ verdict: 'unregistered' });
    expect(verifyNhiActor('mission-orchestration-worker')).toEqual({ verdict: 'unregistered' });
  });

  it('classifies a well-formed but unissued nhi_id as unregistered with the nhi_id', () => {
    expect(verifyNhiActor('kyberion://agent/ni02-org/never-issued')).toEqual({
      verdict: 'unregistered',
      nhi_id: 'kyberion://agent/ni02-org/never-issued',
    });
  });

  it('classifies provisioned and active identities as registered', () => {
    const record = issueTestIdentity('worker-a');
    expect(verifyNhiActor(record.nhi_id)).toEqual({
      verdict: 'registered',
      nhi_id: record.nhi_id,
    });
    withExecutionContext('mission_controller', () => activateAgentIdentity(record.nhi_id));
    clearNhiActorVerificationCache();
    expect(verifyNhiActor(record.nhi_id).verdict).toBe('registered');
  });

  it('classifies suspended and retired identities by lifecycle status', () => {
    const suspended = issueTestIdentity('worker-suspended');
    withExecutionContext('mission_controller', () =>
      suspendAgentIdentity(suspended.nhi_id, 'test')
    );
    const retired = issueTestIdentity('worker-retired');
    withExecutionContext('mission_controller', () => retireAgentIdentity(retired.nhi_id, 'test'));
    clearNhiActorVerificationCache();
    expect(verifyNhiActor(suspended.nhi_id)).toEqual({
      verdict: 'suspended',
      nhi_id: suspended.nhi_id,
    });
    expect(verifyNhiActor(retired.nhi_id)).toEqual({
      verdict: 'retired',
      nhi_id: retired.nhi_id,
    });
  });

  it('memoizes verdicts inside the TTL (advisory hot-path cache, cleared explicitly)', () => {
    const record = issueTestIdentity('worker-cached');
    expect(verifyNhiActor(record.nhi_id).verdict).toBe('registered');
    withExecutionContext('mission_controller', () => retireAgentIdentity(record.nhi_id, 'test'));
    // Within the ~2s TTL the previous verdict is still served from cache.
    expect(verifyNhiActor(record.nhi_id).verdict).toBe('registered');
    clearNhiActorVerificationCache();
    expect(verifyNhiActor(record.nhi_id).verdict).toBe('retired');
  });
});

// ---------------------------------------------------------------------------
// enforceNhiActorPolicy
// ---------------------------------------------------------------------------

describe('nhi-actor-verification — enforceNhiActorPolicy', () => {
  it('off mode is a full no-op: no registry read outcome, no audit, no throw even for retired', () => {
    const record = issueTestIdentity('worker-off');
    withExecutionContext('mission_controller', () => retireAgentIdentity(record.nhi_id, 'test'));
    clearNhiActorVerificationCache();
    process.env.KYBERION_NHI_ACTOR = 'off';
    const outcome = enforceNhiActorPolicy(record.nhi_id, 'test.context');
    expect(outcome).toEqual({ mode: 'off', violation: false });
    expect(auditEvents).toHaveLength(0);
  });

  it('warn (default): unregistered actor is allowed and audit-recorded as nhi_actor_unregistered', () => {
    const outcome = enforceNhiActorPolicy('free-string-actor', 'test.claim');
    expect(outcome.mode).toBe('warn');
    expect(outcome.violation).toBe(true);
    expect(auditEvents).toEqual([
      {
        action: NHI_ACTOR_UNREGISTERED_EVENT,
        actor: 'free-string-actor',
        verdict: 'unregistered',
        context: 'test.claim',
        result: 'allowed',
      },
    ]);
  });

  it('warn: retired identity is allowed and audit-recorded as nhi_actor_inactive', () => {
    const record = issueTestIdentity('worker-warn-retired');
    withExecutionContext('mission_controller', () => retireAgentIdentity(record.nhi_id, 'test'));
    clearNhiActorVerificationCache();
    const outcome = enforceNhiActorPolicy(record.nhi_id, 'test.claim');
    expect(outcome.violation).toBe(true);
    expect(auditEvents[0]).toMatchObject({
      action: NHI_ACTOR_INACTIVE_EVENT,
      verdict: 'retired',
      result: 'allowed',
    });
  });

  it('warn: a throwing audit sink never breaks the allowed path (best-effort contract)', () => {
    setNhiActorAuditSinkForTests(() => {
      throw new Error('audit sink exploded');
    });
    expect(() => enforceNhiActorPolicy('free-string-actor', 'test.claim')).not.toThrow();
  });

  it('registered active identity passes silently in both warn and enforce', () => {
    const record = issueTestIdentity('worker-pass');
    withExecutionContext('mission_controller', () => activateAgentIdentity(record.nhi_id));
    clearNhiActorVerificationCache();
    expect(enforceNhiActorPolicy(record.nhi_id, 'test.claim').violation).toBe(false);
    process.env.KYBERION_NHI_ACTOR = 'enforce';
    expect(() => enforceNhiActorPolicy(record.nhi_id, 'test.claim')).not.toThrow();
    expect(auditEvents).toHaveLength(0);
  });

  it('enforce: unregistered actor is rejected with a typed error and a denied audit event', () => {
    process.env.KYBERION_NHI_ACTOR = 'enforce';
    expect(() => enforceNhiActorPolicy('free-string-actor', 'test.claim')).toThrow(
      NhiActorPolicyError
    );
    expect(auditEvents[0]).toMatchObject({
      action: NHI_ACTOR_UNREGISTERED_EVENT,
      result: 'denied',
    });
  });

  it('enforce: retired identity is rejected (nhi_actor_inactive, denied)', () => {
    const record = issueTestIdentity('worker-enforce-retired');
    withExecutionContext('mission_controller', () => retireAgentIdentity(record.nhi_id, 'test'));
    clearNhiActorVerificationCache();
    process.env.KYBERION_NHI_ACTOR = 'enforce';
    let thrown: unknown;
    try {
      enforceNhiActorPolicy(record.nhi_id, 'test.claim');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NhiActorPolicyError);
    expect((thrown as NhiActorPolicyError).verdict).toBe('retired');
    expect(auditEvents[0]).toMatchObject({
      action: NHI_ACTOR_INACTIVE_EVENT,
      verdict: 'retired',
      result: 'denied',
    });
  });
});

// ---------------------------------------------------------------------------
// Hook: orchestrator-session.createOrchestratorSession (owner_actor)
// ---------------------------------------------------------------------------

describe('nhi-actor-verification — orchestrator-session hook', () => {
  function createSession(ownerActor: string) {
    return withExecutionContext('mission_controller', () =>
      createOrchestratorSession({
        surface: 'slack',
        channel: 'C1',
        threadTs: `${counter}.100`,
        missionId: `MSN-NI02-${counter}`,
        ownerActor,
      })
    );
  }

  it('default warn: an unregistered owner_actor still creates the session (audit only)', () => {
    const record = createSession('legacy-surface-owner');
    expect(record.owner_actor).toBe('legacy-surface-owner');
    expect(auditEvents.some((e) => e.action === NHI_ACTOR_UNREGISTERED_EVENT)).toBe(true);
    expect(
      auditEvents.some((e) => e.context === 'orchestrator-session.createOrchestratorSession')
    ).toBe(true);
  });

  it('enforce: an unregistered owner_actor is rejected before any state is written', () => {
    process.env.KYBERION_NHI_ACTOR = 'enforce';
    expect(() => createSession('legacy-surface-owner')).toThrow(NhiActorPolicyError);
  });

  it('enforce: a registered active nhi owner_actor creates the session', () => {
    const identity = issueTestIdentity('surface-owner');
    withExecutionContext('mission_controller', () => activateAgentIdentity(identity.nhi_id));
    clearNhiActorVerificationCache();
    process.env.KYBERION_NHI_ACTOR = 'enforce';
    const record = createSession(identity.nhi_id);
    expect(record.owner_actor).toBe(identity.nhi_id);
    expect(auditEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Hook: work-coordination claimWorkItem / handoffWorkItem
// ---------------------------------------------------------------------------

describe('nhi-actor-verification — work-coordination hooks', () => {
  it('default warn: a free-string claimant still claims (audit only)', () => {
    const item = createWorkItem({
      title: 'NI-02 warn claim',
      description: 'claimed by a legacy peer id',
      projectId: 'ni02',
    });
    const { lease } = claimWorkItem({
      itemId: item.item_id,
      actorPeerId: 'legacy-peer',
      purpose: 'test',
    });
    expect(lease.holder_peer_id).toBe('legacy-peer');
    expect(auditEvents[0]).toMatchObject({
      action: NHI_ACTOR_UNREGISTERED_EVENT,
      context: 'work-coordination.claimWorkItem',
      result: 'allowed',
    });
  });

  it('enforce: an unregistered claimant is rejected; a registered one claims', () => {
    const identity = issueTestIdentity('claimer');
    withExecutionContext('mission_controller', () => activateAgentIdentity(identity.nhi_id));
    clearNhiActorVerificationCache();
    const item = createWorkItem({
      title: 'NI-02 enforce claim',
      description: 'boundary',
      projectId: 'ni02',
    });
    process.env.KYBERION_NHI_ACTOR = 'enforce';
    expect(() =>
      claimWorkItem({ itemId: item.item_id, actorPeerId: 'legacy-peer', purpose: 'test' })
    ).toThrow(NhiActorPolicyError);
    const { lease } = claimWorkItem({
      itemId: item.item_id,
      actorPeerId: identity.nhi_id,
      purpose: 'test',
    });
    expect(lease.holder_peer_id).toBe(identity.nhi_id);
  });

  it('enforce: a handoff to a retired identity fails BEFORE the from-lease is released', () => {
    const from = issueTestIdentity('handoff-from');
    const to = issueTestIdentity('handoff-to');
    withExecutionContext('mission_controller', () => {
      activateAgentIdentity(from.nhi_id);
      retireAgentIdentity(to.nhi_id, 'test');
    });
    clearNhiActorVerificationCache();
    const item = createWorkItem({
      title: 'NI-02 handoff boundary',
      description: 'handoff to retired',
      projectId: 'ni02',
    });
    const claimed = claimWorkItem({
      itemId: item.item_id,
      actorPeerId: from.nhi_id,
      purpose: 'test',
    });
    process.env.KYBERION_NHI_ACTOR = 'enforce';
    expect(() =>
      handoffWorkItem({
        itemId: item.item_id,
        fromLeaseId: claimed.lease.lease_id,
        fromPeerId: from.nhi_id,
        toPeerId: to.nhi_id,
        purpose: 'test',
      })
    ).toThrow(NhiActorPolicyError);
    // The from-lease must be untouched: the rejection happened up front.
    expect(getWorkItem(item.item_id)?.claimed_by_peer_id).toBe(from.nhi_id);
  });
});
