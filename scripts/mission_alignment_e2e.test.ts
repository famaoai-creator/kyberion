/**
 * MO-11 end-to-end: brief -> approval request -> decision on ANY surface -> gate.
 *
 * Everything here is real except the mission directory lookup: the approval
 * store, the payload binding, and the gate assessment all run against the
 * on-disk governed artifacts. That is the point — the value of MO-11 is that
 * these three pieces agree, and only an integrated test can show it.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

const RUN_ID = `${process.pid}-${Date.now()}`;
const MISSION_ID = `MSN-MO11-E2E-${process.pid}`;

const mocks = vi.hoisted(() => ({
  findMissionPath: vi.fn<(id: string) => string | null>(),
}));

vi.mock('@agent/core', async () => {
  const actual = await vi.importActual<typeof import('@agent/core')>('@agent/core');
  return { ...actual, findMissionPath: mocks.findMissionPath };
});

const {
  approvalRequestLogicalPath,
  decideApprovalRequest,
  listApprovalRequests,
  pathResolver,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
  withExecutionContext,
} = await import('@agent/core');
const { openAlignmentApproval } = await import('./mission_alignment_request.js');
const { assessAlignmentDecision } = await import('./mission_alignment_decision.js');

// active/shared/tmp is the sanctioned scratch location (AGENTS.md invariant).
const MISSION_DIR = pathResolver.shared(`tmp/mo11-e2e-${RUN_ID}/${MISSION_ID}`);
const BRIEF_PATH = path.join(MISSION_DIR, 'evidence', 'mission-brief.json');

const BRIEF = {
  missionId: MISSION_ID,
  title: 'MO-11 E2E ブリーフ',
  intent: 'アラインメント承認がサーフェス横断で一致することを示す',
  victoryConditions: ['承認が payloadHash で brief に束縛される'],
};

function writeBrief(brief: unknown): void {
  safeMkdir(path.dirname(BRIEF_PATH), { recursive: true });
  safeWriteFile(BRIEF_PATH, JSON.stringify(brief, null, 2), { encoding: 'utf8' });
}

beforeAll(() => {
  mocks.findMissionPath.mockImplementation((id) => (id === MISSION_ID ? MISSION_DIR : null));
});

afterEach(() => {
  withExecutionContext('surface_runtime', () => {
    for (const record of listApprovalRequests({ kind: 'mission_gate' })) {
      if (record.correlationId === `mission-alignment-${MISSION_ID}`) {
        safeRmSync(approvalRequestLogicalPath(record.storageChannel, record.id), { force: true });
      }
    }
  });
  safeRmSync(pathResolver.shared(`tmp/mo11-e2e-${RUN_ID}`), { recursive: true, force: true });
});

describe('MO-11 alignment gate end-to-end', () => {
  it('passes the gate only after a real decision, and only for the approved brief', () => {
    writeBrief(BRIEF);

    // 1. No request yet -> the gate refuses rather than defaulting open.
    expect(assessAlignmentDecision(MISSION_ID)).toMatchObject({
      verdict: 'no_request',
      satisfied: false,
    });

    // 2. Opening the approval binds it to this exact brief.
    const opened = openAlignmentApproval(MISSION_ID);
    expect(opened.created).toBe(true);
    expect(opened.requestId).toBeTruthy();

    // 3. Still pending -> still closed.
    expect(assessAlignmentDecision(MISSION_ID)).toMatchObject({
      verdict: 'pending',
      satisfied: false,
    });

    // 4. Decide from a NON-brief path: this is what the concierge route does.
    //    The gate must not care which surface settled it.
    decideApprovalRequest('surface_runtime', {
      channel: 'brief',
      storageChannel: 'brief',
      requestId: opened.requestId!,
      decision: 'approved',
      decidedBy: 'concierge',
      decidedByRole: 'sovereign',
      authMethod: 'surface_session',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: opened.payloadHash,
    });

    const approved = assessAlignmentDecision(MISSION_ID);
    expect(approved).toMatchObject({ verdict: 'approved', satisfied: true });
    expect(approved.decidedBy).toBe('concierge');

    // 5. Edit the brief after approval -> the gate closes again.
    writeBrief({ ...BRIEF, victoryConditions: ['承認後にこっそり足した条件'] });
    const drifted = assessAlignmentDecision(MISSION_ID);
    expect(drifted).toMatchObject({ verdict: 'brief_drifted', satisfied: false });
    expect(drifted.reasons[0]).toMatch(/changed after approval/u);
  });

  it('reuses a pending request instead of scattering duplicates across surfaces', () => {
    writeBrief(BRIEF);

    const first = openAlignmentApproval(MISSION_ID);
    const second = openAlignmentApproval(MISSION_ID);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.requestId).toBe(first.requestId);
    expect(second.reason).toBeUndefined();
  });

  it('refuses to reuse a pending request bound to a different brief', () => {
    writeBrief(BRIEF);
    const first = openAlignmentApproval(MISSION_ID);
    expect(first.created).toBe(true);

    writeBrief({ ...BRIEF, intent: '前提が変わった' });
    const second = openAlignmentApproval(MISSION_ID);

    expect(second.created).toBe(false);
    expect(second.reason).toMatch(/different version of the brief/u);
  });

  it('refuses to open an approval without a brief', () => {
    const result = openAlignmentApproval(MISSION_ID);
    expect(result.created).toBe(false);
    expect(result.reason).toMatch(/brief not found/u);
  });
});
