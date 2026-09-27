/**
 * libs/core/mission-triage.ts
 *
 * Per-mission triage: the read-only diagnosis half of closing stuck
 * missions. `hygiene` finds the population; `triage` answers "why is THIS
 * mission not closed and what is the lowest-privilege command path out of
 * it" — including the approval-mediated scope rebaseline for
 * intent-drift-blocked missions, so the worker never needs SUDO and the
 * human only ever runs `pnpm kyberion approvals --approve <id>`.
 *
 * Read-only by contract: collects state, evaluates gates, and prints a
 * recommendation. The only write path is `--request-approval` in the router,
 * which creates an approval request (state is never mutated by triage).
 */

import * as path from 'node:path';
import { findMissionPath } from './path-resolver.js';
import { safeExistsSync, safeReaddir } from './secure-io.js';
import { loadState } from './mission-state.js';
import {
  readMissionNextTasks,
  MISSION_TASK_COMPLETED_STATUSES,
} from './mission-lifecycle-completion.js';
import { evaluateMissionIntentDrift } from './mission-intent-delta.js';
import type { MissionState } from './mission-types.js';

export type MissionTriageClassification =
  | 'not_found'
  | 'state_unreadable'
  | 'terminal'
  | 'intent_drift_blocked'
  | 'unfinished_tasks'
  | 'awaiting_finish'
  | 'ready_to_verify'
  | 'in_progress'
  | 'not_started';

export type MissionTriageAction =
  'scope_rebaseline' | 'abandon' | 'finish' | 'verify' | 'continue' | 'archive' | 'start' | 'none';

export interface MissionTriageRecommendation {
  action: MissionTriageAction;
  reason: string;
  /** Exact commands in execution order; approval steps are marked inline. */
  commands: string[];
}

export interface MissionTriageReport {
  mission_id: string;
  found: boolean;
  mission_dir?: string;
  status?: string;
  classification: MissionTriageClassification;
  drift?: {
    passed: boolean;
    verdict?: string;
    drift_score?: number;
    message?: string;
  } | null;
  tasks: {
    total: number;
    completed: number;
    pending: string[];
  };
  current_goal?: string;
  intent_drift_gate_failures?: number;
  recommendation: MissionTriageRecommendation;
}

const MC = 'pnpm mission';

function pendingTaskIds(missionDir: string): {
  total: number;
  completed: number;
  pending: string[];
} {
  const tasks = readMissionNextTasks(missionDir);
  const pending = tasks
    .filter(
      (task) => !MISSION_TASK_COMPLETED_STATUSES.has(String(task.status || 'planned').toLowerCase())
    )
    .map((task) => String(task.task_id || task.description || 'unknown-task'));
  return { total: tasks.length, completed: tasks.length - pending.length, pending };
}

function driftBlockedByState(state: MissionState): boolean {
  const context = (state.context || {}) as Record<string, unknown>;
  return state.status === 'validating' && Number(context.intent_drift_gate_failure_count || 0) > 0;
}

function abandonCommands(missionId: string): string[] {
  return [
    `${MC} cancel ${missionId} --note "<why the mission is being abandoned>"`,
    `${MC} archive --mission ${missionId} --execute`,
  ];
}

function scopeRebaselineCommands(missionId: string, goalPlaceholder: string): string[] {
  return [
    `${MC} scope-approve ${missionId} --request-approval --goal "${goalPlaceholder}" --reason "<why the delivered scope is correct>"`,
    `# human: pnpm kyberion approvals  →  pnpm kyberion approvals --approve <request-id>`,
    `${MC} scope-approve ${missionId} --approval-request-id <request-id> --goal "<same goal>" --reason "<same reason>"`,
    `${MC} verify ${missionId} verified "<note>" && ${MC} distill ${missionId} && ${MC} finish ${missionId}`,
    '# keep the verify note aligned with the approved goal — a divergent note can re-block finish',
    '# abandon instead: ' + abandonCommands(missionId).join(' && '),
  ];
}

function classify(
  missionId: string,
  state: MissionState | null,
  missionDir: string | null
): { classification: MissionTriageClassification; recommendation: MissionTriageRecommendation } {
  if (!state || !missionDir) {
    if (missionDir && !state) {
      return {
        classification: 'state_unreadable',
        recommendation: {
          action: 'continue',
          reason:
            'Mission directory exists but mission-state.json is missing or schema-invalid — repair it rather than abandoning.',
          commands: [
            `${MC} repair ${missionId} --note "<what is broken>"`,
            ...abandonCommands(missionId),
          ],
        },
      };
    }
    return {
      classification: 'not_found',
      recommendation: {
        action: 'none',
        reason:
          'Mission directory not found in active mission roots. If it lived in a deleted worktree the ledger is gone — nothing to close; record the outcome in the project ledger instead.',
        commands: [],
      },
    };
  }

  const status = String(state.status || '');
  if (status === 'archived' || status === 'completed' || status === 'failed') {
    return {
      classification: 'terminal',
      recommendation: {
        action: status === 'archived' ? 'none' : 'archive',
        reason:
          status === 'archived'
            ? 'Mission is already archived.'
            : `Mission is ${status} — eligible for explicit archive.`,
        commands: status === 'archived' ? [] : [`${MC} archive --mission ${missionId} --execute`],
      },
    };
  }
  if (status === 'planned') {
    return {
      classification: 'not_started',
      recommendation: {
        action: 'start',
        reason: 'Mission was created but never activated.',
        commands: [`${MC} start ${missionId} --goal "<goal>"`, ...abandonCommands(missionId)],
      },
    };
  }

  const { pending } = pendingTaskIds(missionDir);
  const drift = evaluateMissionIntentDrift(missionId);
  // The drift gate only bites at verify/finish, so a mid-flight active
  // mission with pending work is still 'in_progress' — drift there is a
  // warning to resolve before close, not the current blocker.
  const driftRelevant = status === 'validating' || status === 'distilling' || pending.length === 0;
  const driftBlocked =
    driftRelevant && (Boolean(drift && !drift.passed) || driftBlockedByState(state));

  if (driftBlocked && (status === 'active' || status === 'validating' || status === 'distilling')) {
    const context = (state.context || {}) as Record<string, unknown>;
    const recordedFailures = Number(context.intent_drift_gate_failure_count || 0);
    const blockedReason =
      drift && !drift.passed
        ? `Intent drift gate blocks verify/finish (${drift.message})`
        : `${recordedFailures} recorded intent-drift gate failure(s) (${String(context.intent_drift_gate_last_reason || 'reason not recorded')}); current eval passes but the lifecycle may re-block on a later snapshot`;
    return {
      classification: 'intent_drift_blocked',
      recommendation: {
        action: 'scope_rebaseline',
        reason: `${blockedReason}. A human-approved scope rebaseline resets the origin baseline; abandoning marks the mission failed.`,
        commands: scopeRebaselineCommands(missionId, '<as-delivered goal>'),
      },
    };
  }

  if (status === 'distilling' || status === 'validating') {
    if (pending.length > 0) {
      return {
        classification: 'unfinished_tasks',
        recommendation: {
          action: 'continue',
          reason: `${pending.length} task(s) still open — finish is exit-gate blocked until they complete, get reconciled, or the mission is abandoned.`,
          commands: [
            `${MC} record-evidence ${missionId} <task_id> "<note>" --evidence <deliverable> --actor-id <who>`,
            '# external work: ' +
              `${MC} reconcile-work ${missionId} --manifest <path> --request-approval`,
            '# abandon instead: ' + abandonCommands(missionId).join(' && '),
          ],
        },
      };
    }
    return {
      classification: 'awaiting_finish',
      recommendation: {
        action: 'finish',
        reason: `Mission is ${status} with no pending tasks — complete the lifecycle.`,
        commands: [
          status === 'validating'
            ? `${MC} verify ${missionId} verified "<note>" && ${MC} distill ${missionId} && ${MC} finish ${missionId}`
            : `${MC} finish ${missionId}`,
        ],
      },
    };
  }

  if (status === 'active') {
    if (pending.length > 0) {
      return {
        classification: 'in_progress',
        recommendation: {
          action: 'continue',
          reason: `${pending.length} task(s) still open. Close each task with record-evidence as its phase ends.`,
          commands: [
            `${MC} status ${missionId}`,
            `${MC} record-evidence ${missionId} <task_id> "<note>" --evidence <deliverable> --actor-id <who>`,
            '# abandon instead: ' + abandonCommands(missionId).join(' && '),
          ],
        },
      };
    }
    return {
      classification: 'ready_to_verify',
      recommendation: {
        action: 'verify',
        reason: 'All tasks closed — proceed through the lifecycle.',
        commands: [
          `${MC} verify ${missionId} verified "<note>" && ${MC} distill ${missionId} && ${MC} finish ${missionId}`,
        ],
      },
    };
  }

  if (status === 'paused') {
    return {
      classification: 'in_progress',
      recommendation: {
        action: 'start',
        reason: 'Mission is paused — resume it or abandon it.',
        commands: [`${MC} start ${missionId}`, ...abandonCommands(missionId)],
      },
    };
  }

  return {
    classification: 'in_progress',
    recommendation: {
      action: 'continue',
      reason: `Unrecognized status '${status}' — inspect state directly.`,
      commands: [`${MC} status ${missionId}`],
    },
  };
}

export function collectMissionTriageReport(missionId: string): MissionTriageReport {
  const upperId = String(missionId || '').toUpperCase();
  const missionDir = findMissionPath(upperId);
  const state = missionDir ? loadState(upperId) : null;
  const { classification, recommendation } = classify(upperId, state, missionDir);

  const drift = missionDir ? evaluateMissionIntentDrift(upperId) : null;
  const tasks = missionDir ? pendingTaskIds(missionDir) : { total: 0, completed: 0, pending: [] };
  const context = ((state?.context || {}) as Record<string, unknown>) || {};

  return {
    mission_id: upperId,
    found: Boolean(missionDir && state),
    ...(missionDir ? { mission_dir: missionDir } : {}),
    ...(state?.status ? { status: String(state.status) } : {}),
    classification,
    drift: drift
      ? {
          passed: drift.passed,
          verdict: drift.verdict,
          drift_score: drift.drift_score,
          message: drift.message,
        }
      : null,
    tasks,
    ...(state?.intent?.goal_summary ? { current_goal: String(state.intent.goal_summary) } : {}),
    ...(context.intent_drift_gate_failure_count
      ? { intent_drift_gate_failures: Number(context.intent_drift_gate_failure_count) }
      : {}),
    recommendation,
  };
}

/**
 * Default goal text for a drift rebaseline request when the caller does not
 * pass --goal: keeps the original goal visible and appends the delivered
 * scope so the human sees both sides of the change.
 */
export function draftScopeRebaselineGoal(missionId: string, explicitGoal?: string): string {
  const explicit = String(explicitGoal || '').trim();
  if (explicit) return explicit;
  const state = loadState(missionId.toUpperCase());
  const original = String(state?.intent?.goal_summary || '').trim();
  const missionDir = findMissionPath(missionId.toUpperCase());
  let delivered = '';
  if (missionDir) {
    try {
      const evidenceDir = path.join(missionDir, 'evidence');
      if (safeExistsSync(evidenceDir)) {
        delivered = safeReaddir(evidenceDir)
          .filter((entry) => !entry.startsWith('.'))
          .slice(0, 8)
          .join(', ');
      }
    } catch {
      delivered = '';
    }
  }
  const suffix = delivered ? ` (delivered: ${delivered})` : '';
  return `${original || 'see mission evidence'}${suffix}`;
}
