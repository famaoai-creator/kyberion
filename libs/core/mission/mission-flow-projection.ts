/** Advisory read model only. Candidates never authorize or execute lifecycle mutations. */
import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReaddir } from '../secure-io.js';
import { nowIso } from '../foundation/time.js';
import {
  listApprovalRequests,
  isApprovalRequestExpired,
  approvalRequestLogicalPath,
} from '../governance/approval-store-reader.js';
import { reconcileCompletionStructurally } from '../intent/intent-reconciliation.js';
import { evaluateMissionPrerequisites } from './mission-state.js';
import { loadMissionNextTaskObjectsAtPath } from './mission-next-task-reader.js';
import {
  loadMissionGateRecordAtPath,
  type MissionGateRecord,
} from './mission-gate-record-reader.js';
import {
  buildMissionCompletionReconciliationInput,
  MISSION_TASK_COMPLETED_STATUSES,
} from './mission-lifecycle-completion.js';
import type { MissionState } from './mission-types.js';
import { validatePlannedNextTasks } from './mission-next-task-validation.js';

export interface MissionFlowBlocker {
  code:
    | 'observation_missing'
    | 'observation_unreadable'
    | 'mission_prerequisite'
    | 'task_dependency'
    | 'unfinished_task'
    | 'recorded_gate_failure'
    | 'verification_rejected'
    | 'evidence_gap'
    | 'intent_drift'
    | 'approval_pending'
    | 'approval_expired';
  reason: string;
  evidence_refs: string[];
  task_id?: string;
}

export interface MissionFlowCandidate {
  action: string;
  kind: 'inspect' | 'continue_task' | 'human_decision' | 'lifecycle';
  reason: string;
  evidence_refs: string[];
  task_id?: string;
}

export interface MissionFlowProjection {
  version: 1;
  observed_status: string;
  disposition: 'unknown' | 'requires_work' | 'requires_inspection' | 'candidate' | 'terminal';
  /** A non-atomic observation, never an execution permit or completion certificate. */
  authority: 'none';
  freshness: { observed_at: string; consistency: 'non_atomic'; revalidate_on_execution: true };
  task_board: 'available' | 'missing' | 'unreadable' | 'not_inspected';
  blockers: MissionFlowBlocker[];
  candidates: MissionFlowCandidate[];
  approval_observation: {
    coverage: 'scoped_records_only' | 'unavailable';
    authority_checked: false;
    legacy_unscoped_records: 'not_associated';
  };
  runtime: { state: 'unknown'; reason: string };
  completion: {
    structural: 'satisfied' | 'unsatisfied' | 'not_assessed';
    merge: 'not_assessed';
    deployment: 'not_assessed';
    evidence_refs: string[];
  };
}

function reference(file: string): string {
  return pathResolver.toRepoRelative(file).split(path.sep).join('/');
}

/** Exact-bound observations only; matching a mission name alone is not a scope boundary. */
export function projectMissionApprovalBlockers(
  state: MissionState,
  records: ReturnType<typeof listApprovalRequests>,
  now: number
): MissionFlowBlocker[] {
  return records
    .filter((record) => {
      const scope = record.scope;
      return (
        scope?.tier === state.tier &&
        scope.mission_id === state.mission_id &&
        scope.tenant_slug === state.tenant_slug &&
        scope.organization_id === state.organization_id &&
        scope.project_id === state.relationships?.project?.project_id
      );
    })
    .flatMap((record): MissionFlowBlocker[] => {
      if (record.status === 'approved' && record.applyResult?.result === 'success') return [];
      if (!['pending', 'approved', 'expired'].includes(record.status)) return [];
      const expired = record.status === 'expired' || isApprovalRequestExpired(record, now);
      if (!expired && record.status !== 'pending') return [];
      return [
        {
          code: expired ? 'approval_expired' : 'approval_pending',
          reason: expired
            ? `Approval ${record.id} is expired; obtain a current decision through the governed approval flow.`
            : `Approval ${record.id} is pending a human decision.`,
          evidence_refs: [approvalRequestLogicalPath(record.storageChannel, record.id)],
        },
      ];
    });
}

export function collectMissionFlowProjection(input: {
  missionId: string;
  state: MissionState | null;
  missionDir: string | null;
  recommendation: { action: string; reason: string; commands?: string[] };
  driftBlocked: boolean;
}): MissionFlowProjection {
  const { state, missionDir, missionId, recommendation } = input;
  const flow: MissionFlowProjection = {
    version: 1,
    observed_status: state?.status || 'unknown',
    disposition: 'unknown',
    authority: 'none',
    freshness: { observed_at: nowIso(), consistency: 'non_atomic', revalidate_on_execution: true },
    task_board: 'not_inspected',
    blockers: [],
    candidates: [],
    approval_observation: {
      coverage: 'scoped_records_only',
      authority_checked: false,
      legacy_unscoped_records: 'not_associated',
    },
    runtime: {
      state: 'unknown',
      reason:
        'Runtime readiness was not probed. A roster or historical launch is not current readiness.',
    },
    completion: {
      structural: 'not_assessed',
      merge: 'not_assessed',
      deployment: 'not_assessed',
      evidence_refs: [],
    },
  };
  const add = (blocker: MissionFlowBlocker) => flow.blockers.push(blocker);
  const stateRef = missionDir ? reference(path.join(missionDir, 'mission-state.json')) : '';
  if (!state || !missionDir) {
    add({
      code: 'observation_missing',
      reason: recommendation.reason,
      evidence_refs: stateRef ? [stateRef] : [],
    });
  } else if (['completed', 'archived', 'failed'].includes(state.status)) {
    flow.disposition = 'terminal';
    flow.candidates.push({
      action: recommendation.action,
      kind: 'lifecycle',
      reason: `${recommendation.reason} This lifecycle record does not establish merge or deployment.`,
      evidence_refs: [stateRef],
    });
    return flow;
  } else {
    const boardPath = path.join(missionDir, 'NEXT_TASKS.json');
    const boardRef = reference(boardPath);
    let tasks: Array<Record<string, unknown>> | null = null;
    try {
      if (!safeExistsSync(boardPath)) {
        flow.task_board = 'missing';
        add({
          code: 'observation_missing',
          reason: 'Task board is missing; absence is not proof that all tasks are closed.',
          evidence_refs: [boardRef],
        });
      } else {
        tasks = loadMissionNextTaskObjectsAtPath(boardPath, missionId);
        if (!tasks) throw new Error('Invalid task board');
        if (
          new Set(tasks.map((task) => task.task_id)).size !== tasks.length ||
          tasks.some(
            (task) =>
              typeof task.task_id !== 'string' ||
              !task.task_id.trim() ||
              (task.dependencies !== undefined &&
                (!Array.isArray(task.dependencies) ||
                  task.dependencies.some((id) => typeof id !== 'string')))
          )
        )
          throw new Error('Invalid task identity or dependencies');
        // Reuse the dispatcher's graph checks (missing/self/cyclic dependencies).
        tasks = validatePlannedNextTasks(tasks, missionId).map((task) => ({ ...task }));
        flow.task_board = 'available';
      }
    } catch {
      tasks = null;
      flow.task_board = 'unreadable';
      add({
        code: 'observation_unreadable',
        reason: 'Task board could not be read as a valid mission-bound task list.',
        evidence_refs: [boardRef],
      });
    }
    try {
      for (const missing of evaluateMissionPrerequisites(state.relationships?.prerequisites, {
        tenantSlug: state.tenant_slug,
      }).missing) {
        add({
          code: 'mission_prerequisite',
          reason: `Prerequisite ${missing.mission_id}: ${missing.reason}${missing.status ? ` (${missing.status})` : ''}.`,
          evidence_refs: [stateRef],
        });
      }
    } catch {
      add({
        code: 'observation_unreadable',
        reason: 'Mission prerequisites could not be observed within the current scope.',
        evidence_refs: [stateRef],
      });
    }
    try {
      if (state.tier !== 'public' && !state.tenant_slug) throw new Error('Unbound tenant');
      const records = listApprovalRequests({
        scope: {
          tier: state.tier,
          tenant_slug: state.tenant_slug,
          organization_id: state.organization_id,
          project_id: state.relationships?.project?.project_id,
          mission_id: missionId,
        },
      });
      flow.blockers.push(
        ...projectMissionApprovalBlockers(state, records, Date.parse(flow.freshness.observed_at))
      );
    } catch {
      flow.approval_observation.coverage = 'unavailable';
    }
    if (state.verification?.status === 'rejected')
      add({
        code: 'verification_rejected',
        reason: `Recorded verification was rejected: ${state.verification.note}`,
        evidence_refs: [stateRef],
      });
    if (input.driftBlocked)
      add({ code: 'intent_drift', reason: recommendation.reason, evidence_refs: [stateRef] });
    const gatesDir = path.join(missionDir, 'gates');
    try {
      const latest = new Map<string, { record: MissionGateRecord; ref: string }>();
      if (safeExistsSync(gatesDir))
        for (const entry of safeReaddir(gatesDir)
          .filter((name) => name.endsWith('.json'))
          .sort()) {
          const file = path.join(gatesDir, entry);
          try {
            const record = loadMissionGateRecordAtPath(file, missionId);
            // Historical overrides never authorize or erase an observed failed check.
            if (record.override) continue;
            if (
              !record.verdict ||
              !record.checked_at ||
              !Number.isFinite(Date.parse(record.checked_at))
            )
              throw new Error('Unknown gate verdict or timestamp');
            if (record.verdict === 'pass' && record.checks?.some((check) => !check.passed))
              throw new Error('Contradictory gate result');
            const key = record.gate_id || entry;
            const prior = latest.get(key);
            const time = record.checked_at ? Date.parse(record.checked_at) : -Infinity;
            const priorTime = prior?.record.checked_at
              ? Date.parse(prior.record.checked_at)
              : -Infinity;
            if (!prior || time > priorTime || (time === priorTime && record.verdict === 'fail'))
              latest.set(key, { record, ref: reference(file) });
          } catch {
            add({
              code: 'observation_unreadable',
              reason: 'A recorded gate result could not be validated.',
              evidence_refs: [reference(file)],
            });
          }
        }
      for (const { record, ref } of latest.values())
        if (record.verdict === 'fail') {
          add({
            code: 'recorded_gate_failure',
            reason: `Recorded gate ${record.gate_id || 'unknown'} failed${record.checked_at ? ` at ${record.checked_at}` : ''}: ${(record.reasons || [record.reason || 'inspect checks']).join('; ')}. Re-evaluate through the governed gate before acting.`,
            evidence_refs: [ref],
          });
        }
    } catch {
      add({
        code: 'observation_unreadable',
        reason: 'Recorded gate observations are unavailable.',
        evidence_refs: [reference(gatesDir)],
      });
    }
    const pending = tasks?.filter(
      (task) => !MISSION_TASK_COMPLETED_STATUSES.has(String(task.status || 'planned').toLowerCase())
    );
    for (const task of pending || []) {
      const taskId = String(task.task_id);
      const unmet = (
        Array.isArray(task.dependencies) ? (task.dependencies as string[]) : []
      ).filter(
        (id) =>
          !tasks?.some(
            (dependency) => dependency.task_id === id && dependency.status === 'completed'
          )
      );
      add({
        code: unmet.length ? 'task_dependency' : 'unfinished_task',
        task_id: taskId,
        reason: unmet.length
          ? `Task ${taskId} has unfinished or missing dependencies: ${unmet.join(', ')}.`
          : `Task ${taskId} is ${String(task.status || 'planned')}; inspect its deliverable and record evidence when its phase ends.`,
        evidence_refs: [`${boardRef}#${encodeURIComponent(taskId)}`],
      });
    }
    if (
      tasks &&
      pending?.length === 0 &&
      ['active', 'validating', 'distilling'].includes(state.status)
    ) {
      try {
        const context = buildMissionCompletionReconciliationInput(missionId, { state, missionDir });
        if (!context) throw new Error('Completion context unavailable');
        const result = reconcileCompletionStructurally(context.reconciliationInput);
        flow.completion.structural = result.satisfied ? 'satisfied' : 'unsatisfied';
        flow.completion.evidence_refs = context.evidenceRefs;
        if (!result.satisfied)
          add({
            code: 'evidence_gap',
            reason: `Structural completion evidence is insufficient: ${result.gaps.join('; ') || 'no supporting evidence'}.`,
            evidence_refs: context.evidenceRefs.length
              ? context.evidenceRefs
              : [reference(path.join(missionDir, 'evidence'))],
          });
      } catch {
        add({
          code: 'observation_unreadable',
          reason: 'Completion evidence could not be inspected.',
          evidence_refs: [reference(path.join(missionDir, 'evidence'))],
        });
      }
    }
  }
  const work = flow.blockers.filter((item) => item.code === 'unfinished_task');
  const inspection = flow.blockers.filter(
    (item) => !['unfinished_task', 'task_dependency'].includes(item.code)
  );
  const needsActivation = state?.status === 'planned' || state?.status === 'paused';
  const selected = inspection.length
    ? inspection
    : needsActivation
      ? []
      : work.length
        ? work
        : flow.blockers;
  flow.candidates = selected.map((blocker) => ({
    action:
      blocker.code === 'unfinished_task'
        ? 'continue_task'
        : blocker.code === 'approval_pending'
          ? 'review_approval'
          : blocker.code === 'intent_drift'
            ? 'scope_rebaseline'
            : `inspect_${blocker.code}`,
    kind:
      blocker.code === 'unfinished_task'
        ? 'continue_task'
        : ['approval_pending', 'approval_expired', 'intent_drift'].includes(blocker.code)
          ? 'human_decision'
          : 'inspect',
    reason: blocker.reason,
    evidence_refs: blocker.evidence_refs,
    ...(blocker.task_id ? { task_id: blocker.task_id } : {}),
  }));
  if (!flow.candidates.length)
    flow.candidates.push({
      action: recommendation.action,
      kind: 'lifecycle',
      reason: recommendation.reason,
      evidence_refs: [...(stateRef ? [stateRef] : []), ...flow.completion.evidence_refs],
    });
  flow.disposition = flow.blockers.some((item) =>
    ['observation_missing', 'observation_unreadable'].includes(item.code)
  )
    ? 'unknown'
    : inspection.length || (!work.length && flow.blockers.length)
      ? 'requires_inspection'
      : work.length && !needsActivation
        ? 'requires_work'
        : 'candidate';
  return flow;
}

export function formatMissionFlowNextAction(flow: MissionFlowProjection): string {
  const candidate = flow.candidates[0];
  return candidate ? `${candidate.action}: ${candidate.reason}` : 'No action candidate observed.';
}
