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
  rollbackBackgroundReviewPatch,
} from '@agent/core/workforce/background-review-patch';
import {
  curateBackgroundReviewProposals,
  restoreBackgroundReviewProposal,
  setBackgroundReviewProposalMaintenance,
} from '@agent/core/workforce/background-review-curator';
import type { MemoryScopeEnvelope } from '@agent/core/knowledge/memory-scope';
import { hasHelpFlag, parseGuardedCliArgs } from '@agent/core/cli-guard';
import { defineScript, isDirectScript } from './lib/harness.js';

const USAGE = [
  'Usage: pnpm background-review <curate|status> [--dry-run] [--scope-json <exact scope>]',
  '  <pin|unpin|hold|manage|restore> --candidate <id> --actor-id <actor> [--dry-run] [--scope-json <exact scope>]',
  '  <request|request-rollback|apply|apply-skill|apply-memory|rollback> --candidate <id> --expected-sha256 <digest> [--requested-by <actor>] [--mission-id <id>]',
  'status previews retention; curate archives eligible proposals; pin protects; hold disables automatic archival; manage re-enables it; restore returns a curator archive to review without applying changes.',
].join('\n');

function usage(): never {
  throw new Error(USAGE);
}

function maintenanceScope(scopeJson: string | undefined): MemoryScopeEnvelope | undefined {
  if (scopeJson === undefined) return undefined;
  const value: unknown = JSON.parse(scopeJson);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected --scope-json to be an exact memory scope object');
  // The registry validates all fields and the exact scope hash. Do not drop
  // unknown fields here, since that could silently select a broader record.
  return value as MemoryScopeEnvelope;
}

export const main = defineScript({
  name: 'background-review',
  flags: ['json', 'dry-run', 'quiet'],
  async run(context) {
    const argv = context.positional;
    const command = argv[0];
    if (hasHelpFlag(argv)) {
      context.print(USAGE);
      return;
    }
    const allowedFlags = ['curate', 'status'].includes(command)
      ? ['--scope-json']
      : ['pin', 'unpin', 'hold', 'manage', 'restore'].includes(command)
        ? ['--candidate', '--actor-id', '--scope-json']
        : [
            '--candidate',
            '--expected-sha256',
            '--requested-by',
            '--mission-id',
            '--approved-by',
            '--approval-ref',
          ];
    const parsed = parseGuardedCliArgs(
      argv,
      {
        command: 'pnpm background-review',
        positional: '<command>',
        options: allowedFlags.map((flag) => ({ flag, value: '<value>' })),
      },
      context.print
    );
    if (parsed.positionals.length !== 1) usage();
    const candidateId = String(parsed.options['--candidate'] || '').trim();
    const actorId = String(parsed.options['--actor-id'] || '').trim();
    const scopeJson = parsed.options['--scope-json'];
    const scope = maintenanceScope(typeof scopeJson === 'string' ? scopeJson : undefined);
    if (['curate', 'status'].includes(command)) {
      const result = curateBackgroundReviewProposals({
        dryRun: command === 'status' || context.dryRun,
        scope,
      });
      context.print({ ok: true, dry_run: command === 'status' || context.dryRun, ...result });
      return;
    }
    if (['pin', 'unpin', 'hold', 'manage', 'restore'].includes(command)) {
      if (!candidateId || !actorId) usage();
      const input = {
        candidateId,
        actorId,
        scope,
        dryRun: context.dryRun,
      };
      const result =
        command === 'restore'
          ? restoreBackgroundReviewProposal(input)
          : setBackgroundReviewProposalMaintenance({
              ...input,
              ...(['pin', 'unpin'].includes(command)
                ? { pinned: command === 'pin' }
                : { automaticArchive: command === 'manage' }),
            });
      context.print({
        ok: true,
        ...result,
        ...(command === 'restore'
          ? { next: 'Proposal restored for review; no knowledge changes were applied or approved.' }
          : {}),
      });
      return;
    }
    // A dry run must never fall through to the effectful approval/apply path.
    if (context.dryRun || scopeJson !== undefined) usage();
    if (
      !['request', 'request-rollback', 'apply', 'apply-skill', 'apply-memory', 'rollback'].includes(
        command
      ) ||
      !candidateId
    )
      usage();
    if (command === 'request' || command === 'request-rollback') {
      const request = createBackgroundReviewApprovalRequest({
        candidateId,
        expectedSha256: String(parsed.options['--expected-sha256'] || '').trim(),
        requestedBy: String(parsed.options['--requested-by'] || '').trim() || undefined,
        missionId: String(parsed.options['--mission-id'] || '').trim() || undefined,
        ...(command === 'request-rollback' ? { rollback: true } : {}),
      });
      context.print({
        ok: true,
        approval_request_id: request.id,
        storage_channel: request.storageChannel,
        candidate_id: candidateId,
        next: `pnpm kyberion approve ${request.id} ${request.storageChannel}`,
      });
      return;
    }
    const approvedBy = String(parsed.options['--approved-by'] || '').trim();
    const approvalRef = String(parsed.options['--approval-ref'] || '').trim();
    if (!approvedBy || !approvalRef) usage();
    const apply =
      command === 'rollback'
        ? rollbackBackgroundReviewPatch
        : command === 'apply-skill'
          ? applyBackgroundReviewSkillPatch
          : command === 'apply-memory'
            ? applyBackgroundReviewMemoryConsolidationPatch
            : applyBackgroundReviewPipelinePatch;
    const result = apply({
      candidateId,
      expectedSha256: String(parsed.options['--expected-sha256'] || '').trim(),
      approvedBy,
      approvalRef,
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
