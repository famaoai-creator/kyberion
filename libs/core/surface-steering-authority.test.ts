import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from './authority.js';
import {
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  releaseWorkItem,
  setWorkCoordinationNamespace,
} from './work-coordination.js';
import {
  createOrchestratorSession,
  releaseOrchestratorSession,
  resetOrchestratorSessionServiceForTests,
} from './orchestrator-session.js';
import {
  assertSurfaceSteeringAuthority,
  formatSteeringRejection,
  isSteeringRejectionUxValid,
  SurfaceSteeringAuthorityError,
  type SurfaceSteeringAuthorityErrorCase,
} from './surface-steering-authority.js';
import { validateSurfaceUxContract } from './surface-ux-contract.js';

/**
 * SO-03 tests. Hermetic like orchestrator-session.test.ts: unique journal
 * path per test + a dedicated work-coordination namespace, never the
 * governed defaults.
 */

const TMP_DIR = `active/shared/tmp/so03-steering-tests-${process.pid}`;
let counter = 0;

function nextJournalPath(): string {
  counter += 1;
  return `${TMP_DIR}/orchestrator-sessions-${counter}.jsonl`;
}

beforeEach(() => {
  setWorkCoordinationNamespace(`surface-steering-authority-so03-tests-${process.pid}`);
  clearWorkCoordinationStore();
  resetOrchestratorSessionServiceForTests(nextJournalPath());
});

afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
});

function createSession(overrides: {
  surface?: string;
  channel?: string;
  threadTs?: string;
  missionId: string;
  ownerActor?: string;
}) {
  return withExecutionContext('mission_controller', () =>
    createOrchestratorSession({
      surface: overrides.surface ?? 'slack',
      channel: overrides.channel ?? 'C1',
      threadTs: overrides.threadTs ?? 'T1',
      missionId: overrides.missionId,
      ownerActor: overrides.ownerActor ?? 'operator-a',
    })
  );
}

describe('assertSurfaceSteeringAuthority', () => {
  it('returns the active session when the thread owns the mission', () => {
    const created = createSession({ missionId: 'MSN-STEER-001' });
    const session = assertSurfaceSteeringAuthority({
      surface: 'slack',
      channel: 'C1',
      threadTs: 'T1',
      missionId: 'MSN-STEER-001',
    });
    expect(session.session_id).toBe(created.session_id);
    expect(session.status).toBe('active');
  });

  it('throws no_session_for_thread when the thread has never had a session', () => {
    let thrown: unknown;
    try {
      assertSurfaceSteeringAuthority({
        surface: 'slack',
        channel: 'never-seen',
        threadTs: 'never-seen',
        missionId: 'MSN-STEER-002',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SurfaceSteeringAuthorityError);
    expect((thrown as SurfaceSteeringAuthorityError).caseId).toBe('no_session_for_thread');
  });

  it('throws different_mission when the thread owns a session for a different mission', () => {
    createSession({ surface: 'slack', channel: 'C2', threadTs: 'T2', missionId: 'MSN-STEER-003' });
    let thrown: unknown;
    try {
      assertSurfaceSteeringAuthority({
        surface: 'slack',
        channel: 'C2',
        threadTs: 'T2',
        missionId: 'MSN-STEER-OTHER',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SurfaceSteeringAuthorityError);
    const error = thrown as SurfaceSteeringAuthorityError;
    expect(error.caseId).toBe('different_mission');
    expect(error.detail.sessionMissionId).toBe('MSN-STEER-003');
  });

  it('throws session_released when the thread released its session for this exact mission', () => {
    const created = createSession({
      surface: 'slack',
      channel: 'C3',
      threadTs: 'T3',
      missionId: 'MSN-STEER-004',
    });
    withExecutionContext('mission_controller', () =>
      releaseOrchestratorSession(created.session_id, 'explicit')
    );

    let thrown: unknown;
    try {
      assertSurfaceSteeringAuthority({
        surface: 'slack',
        channel: 'C3',
        threadTs: 'T3',
        missionId: 'MSN-STEER-004',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SurfaceSteeringAuthorityError);
    const error = thrown as SurfaceSteeringAuthorityError;
    expect(error.caseId).toBe('session_released');
    expect(error.detail.releaseReason).toBe('explicit');
  });

  it('throws lease_expired when the journal shows active but the ownership lease is gone', () => {
    const created = createSession({
      surface: 'slack',
      channel: 'C4',
      threadTs: 'T4',
      missionId: 'MSN-STEER-005',
    });
    // Directly release the underlying work-coordination lease WITHOUT going
    // through releaseOrchestratorSession — the journal still shows this
    // session as active, but the cross-process claim backing it is gone.
    releaseWorkItem({
      itemId: created.ownership_item_id!,
      leaseId: created.lease_id!,
      actorPeerId: created.owner_actor,
    });

    let thrown: unknown;
    try {
      assertSurfaceSteeringAuthority({
        surface: 'slack',
        channel: 'C4',
        threadTs: 'T4',
        missionId: 'MSN-STEER-005',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SurfaceSteeringAuthorityError);
    expect((thrown as SurfaceSteeringAuthorityError).caseId).toBe('lease_expired');
  });
});

describe('formatSteeringRejection', () => {
  const ALL_CASES: SurfaceSteeringAuthorityErrorCase[] = [
    'no_session_for_thread',
    'different_mission',
    'session_released',
    'lease_expired',
  ];

  it('produces text that passes validateSurfaceUxContract for every error case', () => {
    for (const caseId of ALL_CASES) {
      const error = new SurfaceSteeringAuthorityError(
        caseId,
        { surface: 'slack', channel: 'C1', threadTs: 'T1', missionId: 'MSN-STEER-UX' },
        { sessionMissionId: 'MSN-OTHER', releaseReason: 'explicit', leaseId: 'wlease-x' }
      );
      const text = formatSteeringRejection(error);
      const result = validateSurfaceUxContract({ text });
      expect(result.valid, `case=${caseId}: ${result.violations.join('; ')}`).toBe(true);
      expect(isSteeringRejectionUxValid(error)).toBe(true);
    }
  });

  it('includes a state signal and a next-action signal for every case', () => {
    for (const caseId of ALL_CASES) {
      const error = new SurfaceSteeringAuthorityError(caseId, {
        surface: 'slack',
        missionId: 'MSN-STEER-UX-2',
      });
      const text = formatSteeringRejection(error);
      const result = validateSurfaceUxContract({ text });
      expect(result.signals).toContain('state');
      expect(result.signals).toContain('next_action');
    }
  });
});
