import {
  recordAutonomyExecution,
  sweepAutonomyActionStates,
  type AutonomyStateDeps,
} from './autonomy-action-state.js';
import { evaluateAutonomousOpsAction, type AutonomousOpsDecision } from './autonomous-ops-gate.js';
import type { FactoryAutonomyPolicy } from './factory-policy.js';
import {
  FACTORY_BRANCH_PATTERN,
  resolveMissionDevelopmentBranch,
} from '../vcs/development-branch.js';

export const DEFAULT_DEMOTE_ACTIONS = ['pr_merge_low', 'pr_merge_medium'] as const;
export const MAX_REVERT_ATTEMPTS_PER_INCIDENT = 1;
const COMMIT_SHA_RE = /^[a-f0-9]{40,64}$/iu;

export type FactoryPostMergeRevertAction =
  'noop' | 'rerun_main_ci' | 'open_revert_pr' | 'escalate_human';

export type FactoryPostMergeRevertStopReason =
  | 'no_failure'
  | 'invalid_merge_sha'
  | 'rerun_required'
  | 'attempt_cap_reached'
  | 'revert_conflict'
  | 'high_risk_path'
  | 'shadow_mode'
  | 'gate_denied';

export interface FactoryPostMergeRevertInput {
  mission_id: string;
  merge_commit_sha: string;
  pr_number?: number;
  incident_id: string;
  main_ci_failed: boolean;
  failure_reproduced_on_rerun: boolean;
  revert_attempts_used: number;
  revert_conflict?: boolean;
  changed_paths?: readonly string[];
  tenant_slug?: string;
  factory_policy?: FactoryAutonomyPolicy;
  demote_actions?: readonly string[];
  apply_demotion?: boolean;
  autonomy_state_deps?: AutonomyStateDeps;
}

export interface FactoryPostMergeRevertPlan {
  action: FactoryPostMergeRevertAction;
  allowed: boolean;
  stop_reason?: FactoryPostMergeRevertStopReason;
  reason: string;
  revert_branch?: string;
  revert_commit_message?: string;
  commands: string[];
  demote_actions: string[];
  demotion_applied: boolean;
  demoted_actions: string[];
  gate_decision?: AutonomousOpsDecision;
  gate_shadow?: boolean;
}

/**
 * Plan post-merge failure recovery under the `auto_revert_on_main_failure` policy:
 * requires rerun reproduction, optionally demotes merge autonomy via `autonomy-action-state`,
 * bounds retries to 1 revert PR per incident, and escalates conflicts/high-risk/shadow cases.
 */
export function planFactoryPostMergeRevert(
  input: FactoryPostMergeRevertInput
): FactoryPostMergeRevertPlan {
  const demoteActions = [
    ...(input.demote_actions?.length ? input.demote_actions : DEFAULT_DEMOTE_ACTIONS),
  ];

  if (!input.main_ci_failed) {
    return {
      action: 'noop',
      allowed: false,
      stop_reason: 'no_failure',
      reason: 'Main branch CI did not fail; no revert required',
      commands: [],
      demote_actions: demoteActions,
      demotion_applied: false,
      demoted_actions: [],
    };
  }

  if (!COMMIT_SHA_RE.test(input.merge_commit_sha)) {
    return {
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'invalid_merge_sha',
      reason: `Cannot plan revert without a valid immutable merge commit SHA (got "${input.merge_commit_sha}")`,
      commands: [],
      demote_actions: demoteActions,
      demotion_applied: false,
      demoted_actions: [],
    };
  }

  if (!input.failure_reproduced_on_rerun) {
    return {
      action: 'rerun_main_ci',
      allowed: false,
      stop_reason: 'rerun_required',
      reason: 'Re-run main CI before opening an autonomous revert PR to rule out transient flakes',
      commands: [],
      demote_actions: demoteActions,
      demotion_applied: false,
      demoted_actions: [],
    };
  }

  let demotionApplied = false;
  let demotedActions: string[] = [];
  if (input.apply_demotion === true && demoteActions.length > 0) {
    const stateDeps: AutonomyStateDeps = {
      ...input.autonomy_state_deps,
      ...((input.autonomy_state_deps?.tenantSlug ?? input.tenant_slug)
        ? { tenantSlug: input.autonomy_state_deps?.tenantSlug ?? input.tenant_slug }
        : {}),
    };
    for (const actionId of demoteActions) {
      recordAutonomyExecution(
        {
          action_id: actionId,
          receipt_id: `factory-main-failure:${input.incident_id}:${actionId}`,
          ok: false,
          error: `Reproduced post-merge main CI failure on ${input.merge_commit_sha}`,
        },
        stateDeps
      );
    }
    const sweep = sweepAutonomyActionStates(demoteActions, stateDeps);
    demotionApplied = true;
    demotedActions = sweep.demoted;
  }

  if (input.revert_attempts_used >= MAX_REVERT_ATTEMPTS_PER_INCIDENT) {
    return {
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'attempt_cap_reached',
      reason: `Auto-revert limit reached (${input.revert_attempts_used}/${MAX_REVERT_ATTEMPTS_PER_INCIDENT}) for incident ${input.incident_id}`,
      commands: [],
      demote_actions: demoteActions,
      demotion_applied: demotionApplied,
      demoted_actions: demotedActions,
    };
  }

  if (input.revert_conflict === true) {
    return {
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'revert_conflict',
      reason: `Revert of ${input.merge_commit_sha} conflicts with subsequent main commits; human resolution required`,
      commands: [],
      demote_actions: demoteActions,
      demotion_applied: demotionApplied,
      demoted_actions: demotedActions,
    };
  }

  const gate = evaluateAutonomousOpsAction({
    actionId: 'auto_revert_on_main_failure',
    tenantSlug: input.tenant_slug,
    changedPaths: input.changed_paths ? [...input.changed_paths] : undefined,
    factoryPolicy: input.factory_policy,
  });

  if (gate.highRiskPathMatches.length > 0) {
    return {
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'high_risk_path',
      reason: `Post-merge revert touches high_risk_paths (${gate.highRiskPathMatches.join(', ')}); human approval required`,
      commands: [],
      demote_actions: demoteActions,
      demotion_applied: demotionApplied,
      demoted_actions: demotedActions,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
    };
  }

  if (gate.shadow) {
    return {
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'shadow_mode',
      reason: `auto_revert_on_main_failure remains in shadow mode${input.tenant_slug ? ` for tenant ${input.tenant_slug}` : ''}; human approval required`,
      commands: [],
      demote_actions: demoteActions,
      demotion_applied: demotionApplied,
      demoted_actions: demotedActions,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
    };
  }

  if (!gate.allowed) {
    return {
      action: 'escalate_human',
      allowed: false,
      stop_reason: 'gate_denied',
      reason: gate.reason || 'auto_revert_on_main_failure was denied by autonomous ops gate',
      commands: [],
      demote_actions: demoteActions,
      demotion_applied: demotionApplied,
      demoted_actions: demotedActions,
      gate_decision: gate.decision,
      gate_shadow: gate.shadow,
    };
  }

  const shortSha = input.merge_commit_sha.slice(0, 10).toLowerCase();
  const revertBranch = resolveMissionDevelopmentBranch(`agent/factory-revert-${shortSha}`);
  const revertCommitMessage = `revert: revert ${shortSha} (${input.mission_id})`;
  const commands = [
    `git checkout -b ${revertBranch} origin/main`,
    `git revert --no-edit ${input.merge_commit_sha}`,
  ];

  return {
    action: 'open_revert_pr',
    allowed: true,
    reason: `Reproduced post-merge failure on ${shortSha}; cleared to open revert PR on ${revertBranch}`,
    revert_branch: revertBranch,
    revert_commit_message: revertCommitMessage,
    commands,
    demote_actions: demoteActions,
    demotion_applied: demotionApplied,
    demoted_actions: demotedActions,
    gate_decision: gate.decision,
    gate_shadow: false,
  };
}

export interface FactoryConvergenceInput {
  mission_id: string;
  mission_status: string;
  development_branch: string;
  merge_commit_sha?: string;
  pr_number?: number;
  pr_url?: string;
  worktree_path?: string;
  main_ci_verified: boolean;
}

export type FactoryConvergenceStepKind =
  | 'finish_mission'
  | 'sync_main'
  | 'remove_worktree'
  | 'delete_local_branch'
  | 'delete_remote_branch';

export interface FactoryConvergenceStep {
  kind: FactoryConvergenceStepKind;
  required: boolean;
  eligible: boolean;
  command: string;
  reason: string;
}

export interface FactoryConvergencePlan {
  mission_id: string;
  mission_status: string;
  development_branch: string;
  merge_commit_verified: boolean;
  main_ci_verified: boolean;
  mission_terminal: boolean;
  ready_for_cleanup: boolean;
  blocking_reasons: string[];
  steps: FactoryConvergenceStep[];
}

/**
 * Build a deterministic post-merge convergence checklist (`finish`, `main` sync, worktree removal,
 * factory branch cleanup). Refuses worktree/branch cleanup until the mission is terminal so the
 * gitignored mission ledger under `active/missions/` is never destroyed prematurely.
 */
export function buildFactoryConvergencePlan(
  input: FactoryConvergenceInput
): FactoryConvergencePlan {
  const branch = resolveMissionDevelopmentBranch(input.development_branch);
  const mergeCommitVerified = Boolean(
    input.merge_commit_sha && COMMIT_SHA_RE.test(input.merge_commit_sha)
  );
  const mainCiVerified = input.main_ci_verified === true;
  const missionTerminal =
    input.mission_status === 'completed' || input.mission_status === 'archived';
  const isFactoryBranch = FACTORY_BRANCH_PATTERN.test(branch);

  const blockingReasons: string[] = [];
  if (!mergeCommitVerified) {
    blockingReasons.push('Immutable merge_commit_sha is missing or invalid.');
  }
  if (!mainCiVerified) {
    blockingReasons.push('Required CI verification on main has not completed.');
  }
  if (!missionTerminal) {
    blockingReasons.push(
      'Mission is non-terminal; preserve worktree and mission ledger under active/missions/ until finish completes.'
    );
  }

  const readyForCleanup = mergeCommitVerified && mainCiVerified && missionTerminal;
  const worktreePath = input.worktree_path?.trim();
  const steps: FactoryConvergenceStep[] = [
    {
      kind: 'finish_mission',
      required: !missionTerminal,
      eligible: !missionTerminal && mergeCommitVerified && mainCiVerified,
      command: `pnpm mission finish ${input.mission_id}`,
      reason: missionTerminal
        ? `Mission ${input.mission_id} is already terminal (${input.mission_status}).`
        : mergeCommitVerified && mainCiVerified
          ? 'Finalize mission ledger before removing the mission worktree.'
          : 'Wait for verified merge commit and main CI before finishing the mission.',
    },
    {
      kind: 'sync_main',
      required: true,
      eligible: mergeCommitVerified && mainCiVerified,
      command: 'git fetch origin main && git merge --ff-only origin/main',
      reason:
        mergeCommitVerified && mainCiVerified
          ? 'Fast-forward local main to the verified merge commit.'
          : 'Do not advance local main before the merge commit and main CI are verified.',
    },
  ];

  if (worktreePath) {
    steps.push({
      kind: 'remove_worktree',
      required: true,
      eligible: readyForCleanup,
      command: `git worktree remove ${worktreePath}`,
      reason: readyForCleanup
        ? 'Mission is terminal and main is verified; safe to remove temporary worktree.'
        : 'Preserve worktree while mission is non-terminal or unverified to avoid losing active/missions/ ledger state.',
    });
  }

  if (isFactoryBranch) {
    steps.push(
      {
        kind: 'delete_local_branch',
        required: false,
        eligible: readyForCleanup,
        command: `git branch -d ${branch}`,
        reason: readyForCleanup
          ? 'Delete merged isolated factory branch locally.'
          : 'Keep factory branch until mission reaches terminal state and main CI is verified.',
      },
      {
        kind: 'delete_remote_branch',
        required: false,
        eligible: readyForCleanup,
        command: `git push origin --delete ${branch}`,
        reason: readyForCleanup
          ? 'Delete merged isolated factory branch on origin.'
          : 'Keep remote factory branch until mission reaches terminal state and main CI is verified.',
      }
    );
  }

  return {
    mission_id: input.mission_id,
    mission_status: input.mission_status,
    development_branch: branch,
    merge_commit_verified: mergeCommitVerified,
    main_ci_verified: mainCiVerified,
    mission_terminal: missionTerminal,
    ready_for_cleanup: readyForCleanup,
    blocking_reasons: blockingReasons,
    steps,
  };
}
