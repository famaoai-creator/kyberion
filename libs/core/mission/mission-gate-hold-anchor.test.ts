import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditChain, type AuditEntry } from '../governance/audit-chain.js';
import * as pathResolver from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  MISSION_HUMAN_HOLDS_ANCHOR_ACTION,
  loadAnchoredHumanHolds,
  recordMissionHumanHoldAnchor,
} from './mission-gate-hold-anchor.js';
import {
  humanHoldGatePassRefusal,
  pendingHumanHoldBeforePhase,
  resolveMissionHumanHoldPlan,
  resolveRequiredHumanHolds,
} from './mission-gate-hold-proof.js';
import { evaluateMissionFinishExitGate } from './mission-lifecycle.js';
import { applyProcessTemplatePlan } from './mission-process-planning.js';
import { safeExistsSync } from '../secure-io.js';
import { resolveMissionWorkflowDesign } from './mission-workflow-catalog.js';

const missionId = 'MSN-GATE-HOLD-ANCHOR-TEST';
const missionPath = pathResolver.missionDir(missionId, 'public');
const SCOPE_GATE = 'REVERSE_SPEC_SCOPE_CONFIRMED';
const GRAPH_GATE = 'CODE_GRAPH_FROZEN';

let recorded: AuditEntry[] = [];
let previousMissionRole: string | undefined;

function writeJson(relative: string, value: unknown): void {
  const file = nodePath.join(missionPath, relative);
  safeMkdir(nodePath.dirname(file), { recursive: true });
  safeWriteFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeState(processTemplate: Record<string, unknown>, missionType?: string): void {
  writeJson('mission-state.json', {
    mission_id: missionId,
    tier: 'public',
    status: 'active',
    execution_mode: 'local',
    priority: 1,
    org_role: 'gate-hold-anchor-test',
    confidence_score: 1,
    git: { branch: 'test', start_commit: 'start', latest_commit: 'start', checkpoints: [] },
    history: [],
    context: {},
    ...(missionType ? { mission_type: missionType } : {}),
    process_template: processTemplate,
  });
}

/** Strip every local anchor: state type fields and the stored gate definitions. */
function stripLocalAnchors(): void {
  writeState({ workflow_id: 'code-change-aidlc', phases: ['execution'] }, 'development');
  safeRmSync(nodePath.join(missionPath, 'gates'), { recursive: true, force: true });
}

beforeEach(() => {
  previousMissionRole = process.env.MISSION_ROLE;
  process.env.MISSION_ROLE = 'mission_controller';
  recorded = [];
  const capture = (entry: Parameters<typeof auditChain.record>[0]): AuditEntry => {
    const stored = {
      ...entry,
      id: `test-${recorded.length}`,
      timestamp: new Date().toISOString(),
      previousHash: '',
      currentHash: '',
    } as AuditEntry;
    recorded.push(stored);
    return stored;
  };
  vi.spyOn(auditChain, 'record').mockImplementation(capture);
  vi.spyOn(auditChain, 'recordDurable').mockImplementation((entry) => capture(entry));
  vi.spyOn(auditChain, 'assertRecordable').mockImplementation(() => undefined);
  vi.spyOn(auditChain, 'loadAll').mockImplementation(() => [...recorded]);
  safeRmSync(missionPath, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  safeRmSync(missionPath, { recursive: true, force: true });
  if (previousMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousMissionRole;
});

describe('audit-chain anchor of required human holds', () => {
  it('records the hold set and reads it back for that mission only', () => {
    recordMissionHumanHoldAnchor(
      missionId,
      [{ gateId: SCOPE_GATE, phase: 'ingest', position: 'exit', phaseOrder: ['ingest', 'x'] }],
      'test'
    );
    recordMissionHumanHoldAnchor(
      'MSN-OTHER',
      [{ gateId: GRAPH_GATE, phase: 'code_graph', position: 'exit', phaseOrder: [] }],
      'test'
    );
    recordMissionHumanHoldAnchor(missionId, [], 'test');

    expect(recorded.map((entry) => entry.action)).toEqual([
      MISSION_HUMAN_HOLDS_ANCHOR_ACTION,
      MISSION_HUMAN_HOLDS_ANCHOR_ACTION,
    ]);
    expect(loadAnchoredHumanHolds(missionId.toLowerCase())).toEqual([
      { gateId: SCOPE_GATE, phase: 'ingest', position: 'exit', phaseOrder: ['ingest', 'x'] },
    ]);
  });

  it('reads a record without a valid position as an entry hold (fails closed)', () => {
    recorded.push({
      action: MISSION_HUMAN_HOLDS_ANCHOR_ACTION,
      metadata: {
        mission_id: missionId,
        holds: [
          { gate_id: 'CUSTOM_HOLD', phase: 'analysis', position: 'sideways' },
          { gate_id: '' },
        ],
      },
    } as unknown as AuditEntry);

    expect(loadAnchoredHumanHolds(missionId)).toEqual([
      { gateId: 'CUSTOM_HOLD', phase: 'analysis', position: 'entry', phaseOrder: [] },
    ]);
  });

  it('plan-tasks anchors the catalog holds of the planned template', () => {
    const design = resolveMissionWorkflowDesign({
      missionTypeHint: 'reverse_spec',
      stage: 'planning',
      executionShape: 'mission',
    });
    expect(design.workflow_id).toBe('reverse-spec-extraction');
    safeMkdir(missionPath, { recursive: true });
    writeState({ workflow_id: design.workflow_id, phases: design.phases }, 'reverse_spec');

    applyProcessTemplatePlan({ missionId, missionDir: missionPath, design });

    const anchors = recorded.filter((entry) => entry.action === MISSION_HUMAN_HOLDS_ANCHOR_ACTION);
    expect(anchors).toHaveLength(1);
    expect(anchors[0].metadata?.source).toBe('process_template:reverse-spec-extraction');
    expect(
      loadAnchoredHumanHolds(missionId)
        .map((hold) => hold.gateId)
        .sort()
    ).toEqual([GRAPH_GATE, SCOPE_GATE].sort());
  });

  it('keeps holding finish and gate-pass after the local anchors are stripped', () => {
    const design = resolveMissionWorkflowDesign({
      missionTypeHint: 'reverse_spec',
      stage: 'planning',
      executionShape: 'mission',
    });
    safeMkdir(missionPath, { recursive: true });
    writeState({ workflow_id: design.workflow_id, phases: design.phases }, 'reverse_spec');
    applyProcessTemplatePlan({ missionId, missionDir: missionPath, design });
    writeJson('NEXT_TASKS.json', []);
    stripLocalAnchors();

    // The frequent checks only see the local anchors, which are gone ...
    expect(resolveRequiredHumanHolds(missionId, missionPath)).toEqual([]);
    // ... the terminal checks still see the anchored holds, in the catalog's phases.
    expect(
      resolveRequiredHumanHolds(missionId, missionPath, { auditAnchor: true })
        .map((hold) => `${hold.gateId}@${hold.phase}`)
        .sort()
    ).toEqual([`${GRAPH_GATE}@code_graph`, `${SCOPE_GATE}@ingest`].sort());
    expect(
      pendingHumanHoldBeforePhase(missionId, 'delivery', missionPath, { auditAnchor: true })?.reason
    ).toBe('gate_definition_missing');

    const finish = evaluateMissionFinishExitGate(missionPath);
    expect(finish.ok).toBe(false);
    expect(finish.reason).toContain(SCOPE_GATE);
    expect(finish.reason).toContain('plan-tasks');
  });

  it('blocks finish when the audit chain cannot be read', () => {
    safeMkdir(missionPath, { recursive: true });
    writeState({ workflow_id: 'code-change-aidlc', phases: ['execution'] }, 'development');
    writeJson('NEXT_TASKS.json', []);
    vi.spyOn(auditChain, 'loadAll').mockImplementation(() => {
      throw new Error('chain read denied');
    });

    expect(resolveMissionHumanHoldPlan(missionId, missionPath).holds).toEqual([]);
    const finish = evaluateMissionFinishExitGate(missionPath);
    expect(finish.ok).toBe(false);
    expect(finish.reason).toContain('audit chain is unreadable');
  });

  function planReverseSpec(): void {
    const design = resolveMissionWorkflowDesign({
      missionTypeHint: 'reverse_spec',
      stage: 'planning',
      executionShape: 'mission',
    });
    safeMkdir(missionPath, { recursive: true });
    writeState({ workflow_id: design.workflow_id, phases: design.phases }, 'reverse_spec');
    applyProcessTemplatePlan({ missionId, missionDir: missionPath, design });
    writeJson('NEXT_TASKS.json', []);
  }

  it('keys finish by the resolved mission, not by a rewritten mission_id', () => {
    planReverseSpec();
    stripLocalAnchors();
    const forged = { mission_id: 'MSN-SOMETHING-ELSE', status: 'active', history: [] };
    writeJson('mission-state.json', forged);

    const finish = evaluateMissionFinishExitGate(missionPath, forged, missionId);
    expect(finish.ok).toBe(false);
    expect(finish.reason).toContain(SCOPE_GATE);
    // Without the caller's id the directory name is used, never the state field.
    expect(evaluateMissionFinishExitGate(missionPath, forged).ok).toBe(false);
  });

  it('refuses gate-pass of later, unknown-phase and hold gates of a stripped mission', () => {
    planReverseSpec();
    stripLocalAnchors();
    // A later machine-checkable gate the agent kept (or wrote) a definition for.
    writeJson('gates/definitions/LATER_GATE.json', {
      mission_id: missionId,
      phase: 'analysis',
      position: 'exit',
      gate: { id: 'LATER_GATE', checks: [{ kind: 'evidence_exists', params: { path: 'x' } }] },
    });

    expect(humanHoldGatePassRefusal(missionId, 'LATER_GATE', 'analysis')).toMatchObject({
      code: 'HUMAN_HOLD_PENDING',
      hold: { gateId: SCOPE_GATE },
    });
    expect(humanHoldGatePassRefusal(missionId, 'NO_DEFINITION', undefined)?.code).toBe(
      'HUMAN_HOLD_PENDING'
    );
    // The first hold itself: nothing earlier blocks it, but it needs its approval.
    expect(humanHoldGatePassRefusal(missionId, SCOPE_GATE, 'ingest')).toEqual({
      code: 'HUMAN_HOLD_APPROVAL_REQUIRED',
    });
    // A later hold is blocked by the earlier one even with an approval applied.
    expect(
      humanHoldGatePassRefusal(missionId, GRAPH_GATE, 'code_graph', { approvalApplied: true })
    ).toMatchObject({ code: 'HUMAN_HOLD_PENDING', hold: { gateId: SCOPE_GATE } });
    expect(humanHoldGatePassRefusal('MSN-WITHOUT-HOLDS', 'ANY', undefined)).toBeUndefined();
    // A gate relabelled into the hold's own phase cannot exit that phase either;
    // an entry gate of that phase still passes.
    expect(humanHoldGatePassRefusal(missionId, 'LATER_GATE', 'ingest')?.code).toBe(
      'HUMAN_HOLD_PENDING'
    );
    expect(
      humanHoldGatePassRefusal(missionId, 'INGEST_ENTRY', 'ingest', { gatePosition: 'entry' })
    ).toBeUndefined();
  });

  it('keeps the planned placement of an anchored non-catalog hold over the local copy', () => {
    safeMkdir(missionPath, { recursive: true });
    writeState({ workflow_id: 'code-change-aidlc', phases: ['a', 'b', 'c'] }, 'development');
    recordMissionHumanHoldAnchor(
      missionId,
      [{ gateId: 'CUSTOM_HOLD', phase: 'a', position: 'exit', phaseOrder: ['a', 'b', 'c'] }],
      'test'
    );
    // The agent moves the local copy of the hold to the last phase.
    writeJson('gates/definitions/CUSTOM_HOLD.json', {
      mission_id: missionId,
      phase: 'c',
      position: 'exit',
      gate: {
        id: 'CUSTOM_HOLD',
        checks: [{ kind: 'human_override', params: { require_signature: true } }],
      },
    });

    const [hold] = resolveMissionHumanHoldPlan(missionId, missionPath, {
      auditAnchor: true,
    }).holds;
    expect(hold).toMatchObject({ gateId: 'CUSTOM_HOLD', phase: 'a' });
  });

  it('plans nothing when the chain refuses the anchor record', () => {
    vi.spyOn(auditChain, 'assertRecordable').mockImplementation(() => {
      throw new Error('missing_audit_chain_key');
    });
    expect(() => planReverseSpec()).toThrow('missing_audit_chain_key');
    expect(safeExistsSync(nodePath.join(missionPath, 'NEXT_TASKS.json'))).toBe(false);
    expect(safeExistsSync(nodePath.join(missionPath, 'gates', 'definitions'))).toBe(false);
  });
});
