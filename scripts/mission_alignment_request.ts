/**
 * mission_alignment_request.ts — MO-11 AG-02
 *
 * Opens the Sovereign alignment approval for a mission: reads the mission's
 * brief, binds a hash of it to a `mission_gate` approval request, and puts that
 * request into the surface-agnostic approval store.
 *
 * From that moment the request is visible — and decidable — on every surface at
 * once: the concierge queue, chronos, presence-studio, Slack, the terminal
 * tools, and the mission-brief HTML page. Whichever surface the Sovereign uses,
 * the same record is updated through decideApprovalRequest, and
 * `mission_alignment_decision --strict` reads that one record.
 *
 * The payload binding is the point: `accountability.payloadHash` pins the
 * approval to the exact brief that was approved, so editing the brief
 * afterwards invalidates the gate instead of silently inheriting the verdict.
 *
 *   node dist/scripts/mission_alignment_request.js --mission <ID> [--json]
 */

import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  currentProcessArgv,
  defineScript,
  isDirectScript,
  ScriptExitError,
} from './lib/harness.js';
import { loadApprovalRequest } from '@agent/core/governance/approval-store';
import { findMissionPath as resolveMissionPath } from '@agent/core/path-resolver';
import { ALIGNMENT_BRIEF_RELATIVE_PATH } from './mission_alignment_decision.js';
import {
  openAlignmentApproval,
  formatAlignmentRequest,
  type OpenAlignmentApprovalResult,
} from './mission-alignment-gate/alignment-approval.js';
// Compatibility for existing integrations; shared implementation has no CLI dependency.
export {
  ALIGNMENT_APPROVAL_CHANNEL,
  openAlignmentApproval,
  formatAlignmentRequest,
  type OpenAlignmentApprovalResult,
} from './mission-alignment-gate/alignment-approval.js';

export async function main(args = currentProcessArgv()): Promise<OpenAlignmentApprovalResult> {
  const argv = await createStandardYargs(['node', 'mission_alignment_request', ...args])
    .option('mission', { alias: 'm', type: 'string' })
    .option('work-item', {
      type: 'string',
      describe: 'Prepare exact human-directed alignment for an existing Dot mission intake',
    })
    .option('expected-work-item-version', { type: 'number', hidden: true })
    .conflicts('mission', 'work-item')
    .check((values) => {
      if (!values.mission && !values['work-item'])
        throw new Error('--mission or --work-item is required');
      return true;
    })
    .option('requested-by', { type: 'string' })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  if (argv['work-item']) {
    const { continueHumanMissionAdmission } = await import('./mission_admission_continuation.js');
    const continuation = await continueHumanMissionAdmission(String(argv['work-item']), {
      prepare: true,
      ...(argv['expected-work-item-version'] !== undefined
        ? { expectedVersion: Number(argv['expected-work-item-version']) }
        : {}),
    });
    const stored = continuation.requestId
      ? loadApprovalRequest('brief', continuation.requestId)
      : null;
    const dir = continuation.missionId ? resolveMissionPath(continuation.missionId) : undefined;
    return {
      missionId: continuation.missionId ?? '',
      created: continuation.approvalCreated === true,
      requestId: continuation.requestId,
      payloadHash: stored?.accountability?.payloadHash,
      briefPath: dir ? path.join(dir, ALIGNMENT_BRIEF_RELATIVE_PATH) : '',
      ...(['pending_approval', 'approved', 'completed'].includes(continuation.status)
        ? {}
        : { reason: continuation.reason ?? continuation.status }),
    };
  }
  const result = openAlignmentApproval(String(argv.mission), {
    ...(argv['requested-by'] ? { requestedBy: String(argv['requested-by']) } : {}),
  });

  return result;
}

export const runMissionAlignmentRequest = defineScript({
  name: 'mission:alignment-request',
  flags: ['json'],
  async run(context) {
    const result = await main(context.argv);
    context.print(context.json ? result : formatAlignmentRequest(result));
    if (result.reason) throw new ScriptExitError(1, result.reason);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'mission_alignment_request.ts') ||
  isDirectScript(import.meta.url, 'mission_alignment_request.js')
)
  void runMissionAlignmentRequest();
