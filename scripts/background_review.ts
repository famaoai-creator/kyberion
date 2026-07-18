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
  createBackgroundReviewApprovalRequest,
} from '@agent/core';

function flag(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  return index >= 0 ? String(argv[index + 1] || '').trim() : '';
}

function usage(): never {
  throw new Error(
    'Usage: pnpm background-review <request|apply|apply-skill> --candidate <id> --expected-sha256 <digest> [--requested-by <actor>] [--mission-id <id>]'
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (!['request', 'apply', 'apply-skill'].includes(argv[0]) || !flag(argv, '--candidate')) usage();
  if (argv[0] === 'request') {
    const request = createBackgroundReviewApprovalRequest({
      candidateId: flag(argv, '--candidate'),
      expectedSha256: flag(argv, '--expected-sha256'),
      requestedBy: flag(argv, '--requested-by') || undefined,
      missionId: flag(argv, '--mission-id') || undefined,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          approval_request_id: request.id,
          storage_channel: request.storageChannel,
          candidate_id: flag(argv, '--candidate'),
          next: `pnpm cli -- approve ${request.id} ${request.storageChannel}`,
        },
        null,
        2
      )}\n`
    );
    return;
  }
  if (!flag(argv, '--approved-by') || !flag(argv, '--approval-ref')) usage();
  const apply =
    argv[0] === 'apply-skill'
      ? applyBackgroundReviewSkillPatch
      : applyBackgroundReviewPipelinePatch;
  const result = apply({
    candidateId: flag(argv, '--candidate'),
    expectedSha256: flag(argv, '--expected-sha256'),
    approvedBy: flag(argv, '--approved-by'),
    approvalRef: flag(argv, '--approval-ref'),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
