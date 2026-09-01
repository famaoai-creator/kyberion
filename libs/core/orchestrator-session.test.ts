import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeRmSync } from './secure-io.js';
import * as secureIo from './secure-io.js';
import { getFoundationIo } from './foundation/io.js';
import { withExecutionContext } from './authority.js';
import {
  buildMissionLifecycleService,
  type MissionLifecycleUnderlyingSystem,
} from './mission-lifecycle-service.js';
import {
  claimWorkItem,
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  getWorkItem,
  listActiveWorkLeases,
  releaseWorkItem,
  setWorkCoordinationNamespace,
} from './work-coordination.js';
import {
  createOrchestratorSession,
  deriveMissionOwnershipItemId,
  deriveSurfaceSessionId,
  getActiveSessionForMission,
  getSessionForThread,
  listOrchestratorSessions,
  normalizeOrchestratorMissionId,
  ORCHESTRATOR_SESSION_LEASE_TTL_MS,
  releaseOrchestratorSession,
  releaseOrchestratorSessionForMission,
  renewOrchestratorSessionLease,
  resetOrchestratorSessionServiceForTests,
  ORCHESTRATOR_SESSION_OPS,
  OrchestratorSessionGovernedError,
  OrchestratorSessionOwnershipConflictError,
  OrchestratorSessionJournal,
} from './orchestrator-session.js';

/**
 * SO-02/SO-03 tests. Hermetic: every test points the module-level singleton
 * at a fresh, unique journal path under active/shared/tmp/ (never the
 * governed default path), via `resetOrchestratorSessionServiceForTests` —
 * mirrors the KD-03 `worker-state-journal.test.ts` unique-tmp-journal
 * pattern. SO-03 additionally routes through work-coordination for the
 * mission-ownership claim, so every test also runs under a dedicated
 * work-coordination namespace (mirrors work-coordination.test.ts) — never
 * the shared default store.
 */

const TMP_DIR = `active/shared/tmp/so02-tests-${process.pid}`;
let counter = 0;

function nextJournalPath(): string {
  counter += 1;
  return `${TMP_DIR}/orchestrator-sessions-${counter}.jsonl`;
}

function cleanupTmpDir(): void {
  const dir = pathResolver.rootResolve(TMP_DIR);
  if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
}

let previousMissionRole: string | undefined;
let previousPersona: string | undefined;

beforeEach(() => {
  previousMissionRole = process.env.MISSION_ROLE;
  previousPersona = process.env.KYBERION_PERSONA;
  delete process.env.MISSION_ROLE;
  delete process.env.KYBERION_PERSONA;
  setWorkCoordinationNamespace(`orchestrator-session-so03-tests-${process.pid}`);
  clearWorkCoordinationStore();
  resetOrchestratorSessionServiceForTests(nextJournalPath());
});

afterEach(() => {
  if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousMissionRole;
  if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = previousPersona;
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

afterAll(() => cleanupTmpDir());

// ---------------------------------------------------------------------------
// deriveSurfaceSessionId: single source of truth, pinned regression hashes
// ---------------------------------------------------------------------------

describe('orchestrator-session — deriveSurfaceSessionId (HA-01 derivation, extracted)', () => {
  it('is byte-identical to the inline derivation it replaced (pinned hash)', () => {
    // Pinned: sha256('slack:C123:T456').hex.slice(0,32), prefixed 'surface-'.
    // Regresses surface-runtime-orchestrator.ts's HA-01 session key unchanged.
    expect(deriveSurfaceSessionId('slack', 'C123', 'T456')).toBe(
      'surface-6309d15416f95f9802ed55584694eb7d'
    );
  });

  it('defaults missing channel/thread to "default" (pinned hash)', () => {
    // Pinned: sha256('terminal:default:default').hex.slice(0,32).
    expect(deriveSurfaceSessionId('terminal')).toBe('surface-42455178d4adc81534b47efdacaba60d');
    expect(deriveSurfaceSessionId('terminal', undefined, undefined)).toBe(
      'surface-42455178d4adc81534b47efdacaba60d'
    );
  });

  it('is deterministic across calls for the same tuple', () => {
    expect(deriveSurfaceSessionId('slack', 'C1', 'T1')).toBe(
      deriveSurfaceSessionId('slack', 'C1', 'T1')
    );
  });
});

// ---------------------------------------------------------------------------
// Fail-closed execution-context gate (reads ungated)
// ---------------------------------------------------------------------------

describe('orchestrator-session — fail-closed execution-context gate', () => {
  it('createOrchestratorSession throws outside mission_controller context, succeeds inside withExecutionContext', () => {
    const params = {
      surface: 'slack',
      channel: 'C1',
      threadTs: 'T1',
      missionId: 'MSN-SO02-GATE-001',
      ownerActor: 'tester',
    };
    expect(() => createOrchestratorSession(params)).toThrow(OrchestratorSessionGovernedError);
    expect(() => createOrchestratorSession(params)).toThrow(
      /requires mission_controller execution context/
    );

    const record = withExecutionContext('mission_controller', () =>
      createOrchestratorSession(params)
    );
    expect(record.status).toBe('active');
  });

  it('releaseOrchestratorSession/releaseOrchestratorSessionForMission throw outside mission_controller context', () => {
    const record = withExecutionContext('mission_controller', () =>
      createOrchestratorSession({
        surface: 'slack',
        channel: 'C2',
        threadTs: 'T2',
        missionId: 'MSN-SO02-GATE-002',
        ownerActor: 'tester',
      })
    );

    expect(() => releaseOrchestratorSession(record.session_id, 'explicit')).toThrow(
      OrchestratorSessionGovernedError
    );
    expect(() => releaseOrchestratorSessionForMission('MSN-SO02-GATE-002', 'explicit')).toThrow(
      OrchestratorSessionGovernedError
    );

    const released = withExecutionContext('mission_controller', () =>
      releaseOrchestratorSession(record.session_id, 'explicit')
    );
    expect(released?.status).toBe('released');
  });

  it('reads are exempt from the gate: work with no execution context established', () => {
    expect(() => getActiveSessionForMission('MSN-SO02-DOES-NOT-EXIST')).not.toThrow();
    expect(getActiveSessionForMission('MSN-SO02-DOES-NOT-EXIST')).toBeNull();
    expect(() => getSessionForThread('slack', 'nope', 'nope')).not.toThrow();
    expect(() => listOrchestratorSessions()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Create / read-back / release lifecycle
// ---------------------------------------------------------------------------

describe('orchestrator-session — create/read-back/release lifecycle', () => {
  it('creates a session, reads it back by mission and by thread, then releases it', () => {
    const params = {
      surface: 'slack',
      channel: 'C-lifecycle',
      threadTs: 'T-lifecycle',
      missionId: 'MSN-SO02-LIFECYCLE-001',
      ownerActor: 'operator-1',
    };

    const created = withExecutionContext('mission_controller', () =>
      createOrchestratorSession(params)
    );
    expect(created.status).toBe('active');
    expect(created.mission_id).toBe('MSN-SO02-LIFECYCLE-001');
    expect(created.session_id).toBe(deriveSurfaceSessionId('slack', 'C-lifecycle', 'T-lifecycle'));
    expect(created.created_at).toEqual(expect.any(String));

    expect(getActiveSessionForMission('MSN-SO02-LIFECYCLE-001')).toMatchObject({
      session_id: created.session_id,
      status: 'active',
    });
    expect(getSessionForThread('slack', 'C-lifecycle', 'T-lifecycle')).toMatchObject({
      session_id: created.session_id,
    });

    const released = withExecutionContext('mission_controller', () =>
      releaseOrchestratorSession(created.session_id, 'explicit')
    );
    expect(released?.status).toBe('released');
    expect(released?.release_reason).toBe('explicit');
    expect(released?.released_at).toEqual(expect.any(String));

    expect(getActiveSessionForMission('MSN-SO02-LIFECYCLE-001')).toBeNull();
    expect(getSessionForThread('slack', 'C-lifecycle', 'T-lifecycle')).toBeNull();
    // Released sessions remain visible in the full listing.
    expect(listOrchestratorSessions().map((s) => s.session_id)).toContain(created.session_id);
  });

  it('releasing an already-released, unknown, or mission-with-no-active-session target is an idempotent no-op', () => {
    const created = withExecutionContext('mission_controller', () =>
      createOrchestratorSession({
        surface: 'slack',
        channel: 'C-idem',
        threadTs: 'T-idem',
        missionId: 'MSN-SO02-IDEMPOTENT-001',
        ownerActor: 'operator-1',
      })
    );
    withExecutionContext('mission_controller', () =>
      releaseOrchestratorSession(created.session_id, 'explicit')
    );

    const secondRelease = withExecutionContext('mission_controller', () =>
      releaseOrchestratorSession(created.session_id, 'explicit')
    );
    expect(secondRelease).toBeNull();

    const unknownRelease = withExecutionContext('mission_controller', () =>
      releaseOrchestratorSession('surface-does-not-exist', 'explicit')
    );
    expect(unknownRelease).toBeNull();

    const missionRelease = withExecutionContext('mission_controller', () =>
      releaseOrchestratorSessionForMission('MSN-SO02-NO-ACTIVE-SESSION', 'explicit')
    );
    expect(missionRelease).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// One owner per mission (dual-owner rejection)
// ---------------------------------------------------------------------------

describe('orchestrator-session — one owner per mission', () => {
  it('rejects a second create for the same mission from a different thread', () => {
    const missionId = 'MSN-SO02-DUAL-OWNER-001';
    withExecutionContext('mission_controller', () =>
      createOrchestratorSession({
        surface: 'slack',
        channel: 'C-a',
        threadTs: 'T-a',
        missionId,
        ownerActor: 'operator-a',
      })
    );

    expect(() =>
      withExecutionContext('mission_controller', () =>
        createOrchestratorSession({
          surface: 'slack',
          channel: 'C-b',
          threadTs: 'T-b',
          missionId,
          ownerActor: 'operator-b',
        })
      )
    ).toThrow(OrchestratorSessionOwnershipConflictError);
  });

  it('is idempotent for the exact same thread+mission binding while active (returns the existing record)', () => {
    const params = {
      surface: 'slack',
      channel: 'C-same',
      threadTs: 'T-same',
      missionId: 'MSN-SO02-DUAL-OWNER-002',
      ownerActor: 'operator-a',
    };
    const first = withExecutionContext('mission_controller', () =>
      createOrchestratorSession(params)
    );
    const second = withExecutionContext('mission_controller', () =>
      createOrchestratorSession(params)
    );
    expect(second).toEqual(first);
  });

  it('allows a new owner once the prior session for the mission is released', () => {
    const missionId = 'MSN-SO02-DUAL-OWNER-003';
    const first = withExecutionContext('mission_controller', () =>
      createOrchestratorSession({
        surface: 'slack',
        channel: 'C-first',
        threadTs: 'T-first',
        missionId,
        ownerActor: 'operator-a',
      })
    );
    withExecutionContext('mission_controller', () =>
      releaseOrchestratorSession(first.session_id, 'explicit')
    );

    const second = withExecutionContext('mission_controller', () =>
      createOrchestratorSession({
        surface: 'slack',
        channel: 'C-second',
        threadTs: 'T-second',
        missionId,
        ownerActor: 'operator-b',
      })
    );
    expect(second.status).toBe('active');
    expect(second.session_id).not.toBe(first.session_id);
    expect(getActiveSessionForMission(missionId)?.session_id).toBe(second.session_id);
  });
});

// ---------------------------------------------------------------------------
// SO-03: cross-process mission-ownership claim fused into the ceremony
// ---------------------------------------------------------------------------

describe('orchestrator-session — SO-03 mission-ownership claim', () => {
  it('createOrchestratorSession claims a mission-ownership work-item lease and stamps it on the record', () => {
    const missionId = 'MSN-SO03-CLAIM-001';
    const created = withExecutionContext('mission_controller', () =>
      createOrchestratorSession({
        surface: 'slack',
        channel: 'C-claim',
        threadTs: 'T-claim',
        missionId,
        ownerActor: 'operator-a',
      })
    );

    expect(created.lease_id).toEqual(expect.any(String));
    expect(created.ownership_item_id).toBe(deriveMissionOwnershipItemId(missionId));

    const item = getWorkItem(deriveMissionOwnershipItemId(missionId));
    expect(item).not.toBeNull();
    expect(item?.claimed_by_peer_id).toBe('operator-a');
    expect(item?.lease_id).toBe(created.lease_id);

    const activeLeases = listActiveWorkLeases();
    expect(activeLeases.some((lease) => lease.lease_id === created.lease_id)).toBe(true);
  });

  it('a concurrent claim on the same mission-ownership item (simulating a second process) is rejected as a lease conflict, enriched with the holder', () => {
    const missionId = 'MSN-SO03-CLAIM-002';
    const itemId = deriveMissionOwnershipItemId(missionId);

    // Simulate a second process racing ahead of this one: it directly claims
    // the ownership work-item (bypassing createOrchestratorSession/the
    // journal entirely, exactly like a genuinely different OS process would)
    // before this process's createOrchestratorSession ever runs.
    createWorkItem({
      itemId,
      title: `Mission ownership: ${missionId}`,
      description: 'pre-existing claim simulating a second process',
      projectId: 'orchestrator-sessions',
    });
    claimWorkItem({
      itemId,
      actorPeerId: 'other-process-operator',
      purpose: 'mission_ownership',
      ttlMs: ORCHESTRATOR_SESSION_LEASE_TTL_MS,
    });

    let thrown: unknown;
    try {
      withExecutionContext('mission_controller', () =>
        createOrchestratorSession({
          surface: 'slack',
          channel: 'C-claim-2',
          threadTs: 'T-claim-2',
          missionId,
          ownerActor: 'operator-b',
        })
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OrchestratorSessionOwnershipConflictError);
    const conflict = thrown as OrchestratorSessionOwnershipConflictError;
    expect(conflict.missionId).toBe(normalizeOrchestratorMissionId(missionId));
    expect(conflict.message).toContain('other-process-operator');

    // No session/journal record was created for the losing attempt.
    expect(getActiveSessionForMission(missionId)).toBeNull();
  });

  it('releaseOrchestratorSession releases the ownership lease best-effort', () => {
    const missionId = 'MSN-SO03-RELEASE-001';
    const created = withExecutionContext('mission_controller', () =>
      createOrchestratorSession({
        surface: 'slack',
        channel: 'C-rel',
        threadTs: 'T-rel',
        missionId,
        ownerActor: 'operator-a',
      })
    );
    expect(listActiveWorkLeases().some((lease) => lease.lease_id === created.lease_id)).toBe(true);

    withExecutionContext('mission_controller', () =>
      releaseOrchestratorSession(created.session_id, 'explicit')
    );

    expect(listActiveWorkLeases().some((lease) => lease.lease_id === created.lease_id)).toBe(false);
    // The item is free again: a new claim for the same mission succeeds.
    const item = getWorkItem(deriveMissionOwnershipItemId(missionId));
    expect(item?.status).not.toBe('in_progress');
  });

  it('releaseOrchestratorSession does not fail when the ownership lease is already gone (missing/foreign/expired)', () => {
    const missionId = 'MSN-SO03-RELEASE-002';
    const created = withExecutionContext('mission_controller', () =>
      createOrchestratorSession({
        surface: 'slack',
        channel: 'C-rel-2',
        threadTs: 'T-rel-2',
        missionId,
        ownerActor: 'operator-a',
      })
    );

    // Simulate the lease already being gone by releasing it directly via
    // work-coordination before the session release runs.
    releaseWorkItem({
      itemId: created.ownership_item_id!,
      leaseId: created.lease_id!,
      actorPeerId: 'operator-a',
    });

    const released = withExecutionContext('mission_controller', () =>
      releaseOrchestratorSession(created.session_id, 'explicit')
    );
    expect(released?.status).toBe('released');
  });

  it('renewOrchestratorSessionLease extends the ownership lease expiry', () => {
    const missionId = 'MSN-SO03-RENEW-001';
    const created = withExecutionContext('mission_controller', () =>
      createOrchestratorSession({
        surface: 'slack',
        channel: 'C-renew',
        threadTs: 'T-renew',
        missionId,
        ownerActor: 'operator-a',
      })
    );
    const before = getWorkItem(deriveMissionOwnershipItemId(missionId));
    const beforeLease = listActiveWorkLeases().find((lease) => lease.lease_id === created.lease_id);
    expect(beforeLease).toBeDefined();

    const renewed = withExecutionContext('mission_controller', () =>
      renewOrchestratorSessionLease(created.session_id)
    );
    expect(renewed.lease_id).toBe(created.lease_id);
    expect(new Date(renewed.expires_at).getTime()).toBeGreaterThanOrEqual(
      new Date(beforeLease!.expires_at).getTime()
    );
    expect(before?.claimed_by_peer_id).toBe('operator-a');
  });

  it('renewOrchestratorSessionLease fails closed outside mission_controller context', () => {
    const missionId = 'MSN-SO03-RENEW-002';
    const created = withExecutionContext('mission_controller', () =>
      createOrchestratorSession({
        surface: 'slack',
        channel: 'C-renew-2',
        threadTs: 'T-renew-2',
        missionId,
        ownerActor: 'operator-a',
      })
    );
    expect(() => renewOrchestratorSessionLease(created.session_id)).toThrow(
      OrchestratorSessionGovernedError
    );
  });

  it('renewOrchestratorSessionLease throws for an unknown/released session', () => {
    expect(() =>
      withExecutionContext('mission_controller', () =>
        renewOrchestratorSessionLease('surface-does-not-exist')
      )
    ).toThrow(/is not active/);
  });

  it('a journal record without lease_id/ownership_item_id (pre-SO-03 shape) still parses via restore', () => {
    const journalPath = nextJournalPath();
    const journal = new OrchestratorSessionJournal({ journalPath });
    journal.append(ORCHESTRATOR_SESSION_OPS.sessionCreated, {
      session_id: 'surface-pre-so03',
      surface: 'terminal',
      mission_id: 'MSN-SO03-BACKCOMPAT-001',
      owner_actor: 'operator-a',
      created_at: '2026-07-25T00:00:00.000Z',
      // no lease_id / ownership_item_id — mirrors a record written before SO-03
    });

    const restored = journal.restore();
    const record = restored.sessions['surface-pre-so03'];
    expect(record).toBeDefined();
    expect(record.status).toBe('active');
    expect(record.lease_id).toBeUndefined();
    expect(record.ownership_item_id).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Restart replay (KD-03 pattern)
// ---------------------------------------------------------------------------

describe('orchestrator-session — restart replay', () => {
  it('rejects an external journal path before reading or writing it', () => {
    expect(
      () =>
        new OrchestratorSessionJournal({
          journalPath: '/tmp/orchestrator-session-external.jsonl',
        })
    ).toThrow('RESOURCE_PATH_SCOPE');
  });

  it('a brand-new OrchestratorSessionJournal instance from the same path sees prior sessions, including released ones', () => {
    const journalPath = nextJournalPath();
    const live = new OrchestratorSessionJournal({ journalPath });
    live.append(ORCHESTRATOR_SESSION_OPS.sessionCreated, {
      session_id: 'surface-restart-test',
      surface: 'slack',
      channel: 'C-restart',
      thread_ts: 'T-restart',
      mission_id: 'MSN-SO02-RESTART-001',
      owner_actor: 'operator-a',
      created_at: '2026-07-25T00:00:00.000Z',
    });
    live.append(ORCHESTRATOR_SESSION_OPS.sessionReleased, {
      session_id: 'surface-restart-test',
      released_at: '2026-07-25T00:05:00.000Z',
      release_reason: 'finish',
    });

    // Simulated process restart: brand-new instance, no in-memory carry-over.
    const restored = new OrchestratorSessionJournal({ journalPath }).restore();
    const record = restored.sessions['surface-restart-test'];
    expect(record).toBeDefined();
    expect(record.status).toBe('released');
    expect(record.release_reason).toBe('finish');
    expect(restored.activeByMission['MSN-SO02-RESTART-001']).toBeUndefined();

    // Two independent restores of the same journal are byte-identical.
    const a = new OrchestratorSessionJournal({ journalPath }).restore();
    const b = new OrchestratorSessionJournal({ journalPath }).restore();
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('an active session also survives replay untouched', () => {
    const journalPath = nextJournalPath();
    const live = new OrchestratorSessionJournal({ journalPath });
    live.append(ORCHESTRATOR_SESSION_OPS.sessionCreated, {
      session_id: 'surface-restart-active',
      surface: 'terminal',
      mission_id: 'MSN-SO02-RESTART-002',
      owner_actor: 'operator-a',
      created_at: '2026-07-25T00:00:00.000Z',
    });

    const restored = new OrchestratorSessionJournal({ journalPath }).restore();
    expect(restored.sessions['surface-restart-active'].status).toBe('active');
    expect(restored.activeByMission['MSN-SO02-RESTART-002']).toBe('surface-restart-active');
  });

  it('the module-level service transparently sees prior sessions once repointed at an existing journal path', () => {
    const journalPath = nextJournalPath();
    resetOrchestratorSessionServiceForTests(journalPath);
    const created = withExecutionContext('mission_controller', () =>
      createOrchestratorSession({
        surface: 'slack',
        channel: 'C-svc-restart',
        threadTs: 'T-svc-restart',
        missionId: 'MSN-SO02-SVC-RESTART-001',
        ownerActor: 'operator-a',
      })
    );

    // Simulated restart: fresh in-process state pointed at the same journal.
    resetOrchestratorSessionServiceForTests(journalPath);
    const record = getActiveSessionForMission('MSN-SO02-SVC-RESTART-001');
    expect(record?.session_id).toBe(created.session_id);
    expect(record?.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Finish-release hook (mission-lifecycle-service.ts wiring)
// ---------------------------------------------------------------------------

describe('orchestrator-session x mission-lifecycle-service — finish-release hook', () => {
  function makeStubSystem(): MissionLifecycleUnderlyingSystem {
    return {
      create: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      createCheckpoint: vi.fn(async () => ({ ok: true }) as any),
      verifyMission: vi.fn(async () => undefined),
      finishMission: vi.fn(async () => undefined),
      staffMissionTeam: vi.fn(async () => ({ ok: true }) as any),
      prewarmMissionTeam: vi.fn(async () => ({ status: 'queued' }) as any),
      dispatchMissionWorkItems: vi.fn(async () => ({ ok: true }) as any),
      pauseMission: vi.fn(async () => undefined),
      resumeMission: vi.fn(async () => undefined),
    };
  }

  it('finish succeeds -> the mission\'s active session is released with reason "finish"', async () => {
    const missionId = 'MSN-SO02-FINISH-HOOK-001';
    const created = withExecutionContext('mission_controller', () =>
      createOrchestratorSession({
        surface: 'slack',
        channel: 'C-finish',
        threadTs: 'T-finish',
        missionId,
        ownerActor: 'operator-a',
      })
    );

    const facade = buildMissionLifecycleService(makeStubSystem());
    await withExecutionContext('mission_controller', () => facade.finish(missionId));

    expect(getActiveSessionForMission(missionId)).toBeNull();
    const record = listOrchestratorSessions().find((s) => s.session_id === created.session_id);
    expect(record?.status).toBe('released');
    expect(record?.release_reason).toBe('finish');
  });

  it('a release failure during finish is swallowed (best-effort) and does not fail finish', async () => {
    const missionId = 'MSN-SO02-FINISH-HOOK-002';
    withExecutionContext('mission_controller', () =>
      createOrchestratorSession({
        surface: 'slack',
        channel: 'C-finish-fail',
        threadTs: 'T-finish-fail',
        missionId,
        ownerActor: 'operator-a',
      })
    );

    // Surgical failure: only the orchestrator-session journal append throws
    // (never audit-chain's own append, which shares safeAppendFileSync).
    const foundationIo = getFoundationIo();
    const originalAppend = foundationIo.appendFile;
    const appendSpy = vi
      .spyOn(foundationIo, 'appendFile')
      .mockImplementation((filePath: string, data: string) => {
        if (String(filePath).includes('orchestrator-sessions')) {
          throw new Error('simulated journal write failure');
        }
        return originalAppend.call(foundationIo, filePath, data);
      });

    try {
      const facade = buildMissionLifecycleService(makeStubSystem());
      await expect(
        withExecutionContext('mission_controller', () => facade.finish(missionId))
      ).resolves.not.toThrow();
    } finally {
      appendSpy.mockRestore();
    }

    // The release attempt failed and was swallowed: the session is still active.
    expect(getActiveSessionForMission(missionId)?.status).toBe('active');
  });
});
