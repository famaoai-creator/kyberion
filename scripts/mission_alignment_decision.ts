/**
 * mission_alignment_decision.ts — MO-11 AG-01
 *
 * Resolves the Sovereign's alignment decision for a mission from the
 * surface-agnostic approval store, and (with --strict) turns it into a process
 * gate verdict via the exit code, so a workflow-catalog `command_succeeds`
 * check can consume it:
 *
 *   { "kind": "command_succeeds", "params": { "command": "node", "args": [
 *       "dist/scripts/mission_alignment_decision.js", "--mission", "<ID>", "--strict" ] } }
 *
 * Two invariants this enforces, and why:
 *
 * 1. The approval record is the single source of truth — never the rendered
 *    brief HTML. The brief surface (report-review) is one renderer among
 *    Slack / concierge / chronos / terminal; all of them write the same record
 *    through decideApprovalRequest.
 * 2. The approval is bound to the brief it approved, via payloadHash. Editing
 *    `evidence/mission-brief.json` after approval invalidates the gate rather
 *    than silently carrying the old verdict forward.
 *
 * Path resolution is done here, not in the gate definition: the gate engine's
 * resolveGateCheckPaths only rewrites PATH_KEYS (path/paths/artifact_path/
 * deliverable/evidence_paths) against the mission dir — `args` and `cwd` are
 * left alone, so a relative path in `args` would resolve against the repo root.
 */

import * as path from 'node:path';

import { createStandardYargs } from '@agent/core/cli-utils';
import { safeExistsSync } from '@agent/core/secure-io';
import {
  computeApprovalPayloadHash,
  findMissionPath,
  loadJson,
  listApprovalRequests,
  type ApprovalRequestRecord,
} from '@agent/core';

export const ALIGNMENT_BRIEF_RELATIVE_PATH = path.join('evidence', 'mission-brief.json');
export const ALIGNMENT_APPROVAL_CHANNEL = 'brief';

export type AlignmentDecisionVerdict =
  | 'approved'
  | 'rejected'
  | 'pending'
  | 'no_request'
  | 'no_mission'
  | 'brief_missing'
  | 'brief_drifted'
  | 'unbound';

export interface AlignmentDecisionReport {
  missionId: string;
  verdict: AlignmentDecisionVerdict;
  /** True only when the gate should pass. */
  satisfied: boolean;
  briefPath?: string;
  requestId?: string;
  status?: ApprovalRequestRecord['status'];
  decidedBy?: string;
  decidedAt?: string;
  authMethod?: string;
  surface?: string;
  reasonCategory?: string;
  note?: string;
  reasons: string[];
}

function readBriefHash(briefPath: string): string | undefined {
  if (!safeExistsSync(briefPath)) return undefined;
  try {
    const parsed = loadJson<unknown>(briefPath);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return computeApprovalPayloadHash(parsed as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/**
 * Picks the mission's most recent alignment approval request.
 * listApprovalRequests returns newest-first, so the head wins: a re-requested
 * approval after a `changes` round supersedes the earlier rejected one.
 */
function findAlignmentRequest(missionId: string): ApprovalRequestRecord | undefined {
  return listApprovalRequests({
    storageChannels: [ALIGNMENT_APPROVAL_CHANNEL],
    kind: 'mission_gate',
  }).find(
    (record) =>
      record.source?.missionId?.toUpperCase() === missionId &&
      record.correlationId === `mission-alignment-${missionId}`
  );
}

export function assessAlignmentDecision(missionIdInput: string): AlignmentDecisionReport {
  const missionId = missionIdInput.trim().toUpperCase();
  const missionDir = findMissionPath(missionId);
  if (!missionDir) {
    return {
      missionId,
      verdict: 'no_mission',
      satisfied: false,
      reasons: [`Mission directory for ${missionId} not found.`],
    };
  }

  const briefPath = path.join(missionDir, ALIGNMENT_BRIEF_RELATIVE_PATH);
  const record = findAlignmentRequest(missionId);
  if (!record) {
    return {
      missionId,
      verdict: 'no_request',
      satisfied: false,
      briefPath,
      reasons: [
        `No mission_gate approval request found for ${missionId}. Create one before evaluating the alignment gate.`,
      ],
    };
  }

  const base = {
    missionId,
    briefPath,
    requestId: record.id,
    status: record.status,
    ...(record.decidedBy ? { decidedBy: record.decidedBy } : {}),
    ...(record.decidedAt ? { decidedAt: record.decidedAt } : {}),
    ...(record.requestedByContext?.surface ? { surface: record.requestedByContext.surface } : {}),
  };

  if (record.status !== 'approved') {
    const rejected = record.status === 'rejected';
    return {
      ...base,
      verdict: rejected ? 'rejected' : 'pending',
      satisfied: false,
      reasons: [
        rejected
          ? `Sovereign rejected the alignment brief (request ${record.id}).`
          : `Alignment approval is ${record.status} (request ${record.id}).`,
      ],
    };
  }

  // Approved — now verify the approval is still bound to the brief on disk.
  const expected = record.accountability?.payloadHash;
  if (!expected) {
    return {
      ...base,
      verdict: 'unbound',
      satisfied: false,
      reasons: [
        `Approval ${record.id} carries no accountability.payloadHash, so it cannot be bound to the brief. Fail closed.`,
      ],
    };
  }

  const actual = readBriefHash(briefPath);
  if (!actual) {
    return {
      ...base,
      verdict: 'brief_missing',
      satisfied: false,
      reasons: [`Alignment brief is missing or unreadable at ${briefPath}.`],
    };
  }

  if (actual !== expected) {
    return {
      ...base,
      verdict: 'brief_drifted',
      satisfied: false,
      reasons: [
        `The brief changed after approval (approved ${expected.slice(0, 12)}…, current ${actual.slice(0, 12)}…). Re-request approval for the updated brief.`,
      ],
    };
  }

  return { ...base, verdict: 'approved', satisfied: true, reasons: [] };
}

export async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('mission', { alias: 'm', type: 'string', demandOption: true })
    .option('strict', { type: 'boolean', default: false })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const report = assessAlignmentDecision(String(argv.mission));

  if (argv.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`[alignment-decision] ${report.verdict}: ${report.missionId}\n`);
    if (report.requestId) process.stdout.write(`  request : ${report.requestId}\n`);
    if (report.decidedBy)
      process.stdout.write(`  decided : ${report.decidedBy} @ ${report.decidedAt ?? '-'}\n`);
    if (report.surface) process.stdout.write(`  surface : ${report.surface}\n`);
    for (const reason of report.reasons) process.stdout.write(`  - ${reason}\n`);
  }

  // Backward compatible: only --strict turns the verdict into an exit code, so
  // interactive use keeps exit 0 while the gate check can fail closed.
  process.exitCode = argv.strict && !report.satisfied ? 1 : 0;
}

if (process.argv[1] && /mission_alignment_decision\.(ts|js)$/u.test(process.argv[1])) void main();
