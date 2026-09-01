/**
 * Governed HA-01 background-review maintenance entrypoint.
 *
 * Applying a proposal is intentionally explicit and requires the candidate's
 * current SHA-256 plus a human approval reference. The command never accepts
 * an arbitrary target path; the target comes from the provenance-bound record.
 */

import {
  applyBackgroundReviewPipelinePatch,
  applyBackgroundReviewSkillPatch,
  applyBackgroundReviewMemoryConsolidationPatch,
  createBackgroundReviewApprovalRequest,
} from '@agent/core/background-review';
import { defineScript, isDirectScript } from './lib/harness.js';

function flag(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || '').trim() : '';
}

function usage(): never {
  throw new Error(
    'Usage: pnpm background-review <request|apply|apply-skill|apply-memory> --candidate <id> --expected-sha256 <digest> [--requested-by <actor>] [--mission-id <id>]'
  );
}

export const main = defineScript({
  name: 'background-review',
  flags: [],
  async run(context) {
    const argv = context.positional;
    if (
      !['request', 'apply', 'apply-skill', 'apply-memory'].includes(argv[0]) ||
      !flag(argv, '--candidate')
    )
      usage();
    if (argv[0] === 'request') {
      const request = createBackgroundReviewApprovalRequest({
        candidateId: flag(argv, '--candidate'),
        expectedSha256: flag(argv, '--expected-sha256'),
        requestedBy: flag(argv, '--requested-by') || undefined,
        missionId: flag(argv, '--mission-id') || undefined,
      });
      context.print({
        ok: true,
        approval_request_id: request.id,
        storage_channel: request.storageChannel,
        candidate_id: flag(argv, '--candidate'),
        next: `pnpm kyberion approve ${request.id} ${request.storageChannel}`,
      });
      return;
    }
    if (!flag(argv, '--approved-by') || !flag(argv, '--approval-ref')) usage();
    const apply =
      argv[0] === 'apply-skill'
        ? applyBackgroundReviewSkillPatch
        : argv[0] === 'apply-memory'
          ? applyBackgroundReviewMemoryConsolidationPatch
          : applyBackgroundReviewPipelinePatch;
    const result = apply({
      candidateId: flag(argv, '--candidate'),
      expectedSha256: flag(argv, '--expected-sha256'),
      approvedBy: flag(argv, '--approved-by'),
      approvalRef: flag(argv, '--approval-ref'),
    });
    context.print({ ok: true, ...result });
  },
});

if (
  isDirectScript(import.meta.url, 'background_review.ts') ||
  isDirectScript(import.meta.url, 'background_review.js')
) {
  void main();
}
