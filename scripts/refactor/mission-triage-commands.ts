/**
 * scripts/refactor/mission-triage-commands.ts
 *
 * Command bodies for `mission triage` and `scope-approve --request-approval`.
 * Kept out of mission_controller.ts (which is a thin orchestration layer and
 * sits at the type-ratchet max_lines budget): these gather the display
 * context for the approval draft via the read-only triage report and render
 * the human-facing output.
 */

import { createMissionScopeApprovalRequest } from '@agent/core/mission/mission-scope-approval';
import {
  collectMissionTriageReport,
  draftScopeRebaselineGoal,
} from '@agent/core/mission/mission-triage';
import { logger } from '@agent/core/core';
import { missionControllerRequester } from '../lib/cli-approval-requester.js';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';

type Print = (value: unknown) => void;

export interface ScopeApprovalRequestOptions {
  goalSummary?: string;
  reason?: string;
  successCondition?: string;
  requestedBy?: string;
}

export interface MissionTriageCommandOptions extends ScopeApprovalRequestOptions {
  json?: boolean;
  requestApproval?: boolean;
  goal?: string;
}

/** Human instruction printed after a request is filed. */
export function scopeApprovalApplyHint(missionId: string, requestId: string): string {
  return (
    `Human approval: review with \`pnpm kyberion approvals\`, then ` +
    `\`pnpm kyberion approvals --approve ${requestId}\`. ` +
    `Afterwards apply with \`pnpm mission scope-approve ${missionId.toUpperCase()} ` +
    `--approval-request-id ${requestId} --goal "<same goal>" --reason "<same reason>"\`.`
  );
}

/**
 * File the human approval request for a scope rebaseline without mutating
 * the mission — the apply half is `scope-approve --approval-request-id`.
 */
export async function runScopeApproveRequestApproval(
  missionId: string,
  options: ScopeApprovalRequestOptions | undefined,
  print: Print
): Promise<ApprovalRequestRecord> {
  const report = collectMissionTriageReport(missionId);
  const result = createMissionScopeApprovalRequest({
    missionId,
    // Auto-draft from the recorded goal + delivered evidence when --goal is
    // omitted — same fallback `triage --request-approval` uses.
    goalSummary: options?.goalSummary || draftScopeRebaselineGoal(missionId),
    reason: options?.reason || 'Approved scope adjustment.',
    successCondition: options?.successCondition,
    requester: missionControllerRequester(options?.requestedBy),
    currentGoal: report.current_goal,
    drift: report.drift
      ? { message: report.drift.message, driftScore: report.drift.drift_score }
      : undefined,
  });
  print(JSON.stringify(result, null, 2));
  logger.info(scopeApprovalApplyHint(missionId, result.id));
  return result;
}

/**
 * Read-only stuck-mission diagnosis with an optional one-step approval
 * request when the blocker is intent drift.
 */
export async function runMissionTriage(
  missionId: string,
  options: MissionTriageCommandOptions | undefined,
  print: Print
) {
  const upperId = missionId.toUpperCase();
  const report = collectMissionTriageReport(upperId);
  let scopeApprovalRequest: ApprovalRequestRecord | undefined;
  if (options?.requestApproval) {
    if (report.classification !== 'intent_drift_blocked') {
      throw new Error(
        `[TRIAGE] --request-approval only applies to intent_drift_blocked missions; ${upperId} is '${report.classification}'. Follow the printed recommendation instead.`
      );
    }
    scopeApprovalRequest = createMissionScopeApprovalRequest({
      missionId: upperId,
      goalSummary: draftScopeRebaselineGoal(upperId, options?.goal),
      reason: options?.reason || 'Intent drift rebaseline requested via mission triage.',
      successCondition: options?.successCondition,
      requester: missionControllerRequester(options?.requestedBy),
      currentGoal: report.current_goal,
      drift: report.drift
        ? { message: report.drift.message, driftScore: report.drift.drift_score }
        : undefined,
    });
  }
  if (options?.json) {
    print(
      JSON.stringify(
        {
          ...report,
          ...(scopeApprovalRequest ? { scope_approval_request: scopeApprovalRequest } : {}),
        },
        null,
        2
      )
    );
    return report;
  }
  print(`Mission: ${report.mission_id}`);
  print(`  status: ${report.status || '<none>'}  classification: ${report.classification}`);
  if (report.current_goal) print(`  current goal: ${report.current_goal}`);
  if (report.drift) {
    print(
      `  drift gate: ${report.drift.passed ? 'pass' : 'BLOCKED'} — ${report.drift.message || ''}`
    );
  }
  print(
    `  tasks: ${report.tasks.completed}/${report.tasks.total} closed` +
      (report.tasks.pending.length ? `  pending: ${report.tasks.pending.join(', ')}` : '')
  );
  print(`  recommendation (${report.recommendation.action}): ${report.recommendation.reason}`);
  for (const command of report.recommendation.commands) {
    print(`    $ ${command}`);
  }
  if (scopeApprovalRequest?.id) {
    print('');
    print(`  approval request filed: ${scopeApprovalRequest.id}`);
    if (scopeApprovalRequest.details) print(`\n${scopeApprovalRequest.details}`);
    print(`  → human runs: pnpm kyberion approvals --approve ${scopeApprovalRequest.id}`);
  }
  return report;
}
