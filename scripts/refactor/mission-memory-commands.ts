import { auditChain } from '@agent/core/audit-chain';
import {
  assertMemoryPromotionReviewReady,
  reviewMemoryPromotionCandidate,
  reviewMemoryPromotionQueue,
  type MemoryPromotionReview,
} from '@agent/core/memory-promotion-review';
import {
  listMemoryPromotionCandidates,
  updateMemoryPromotionCandidateStatus,
} from '@agent/core/memory-promotion-queue';
import {
  promoteMemoryCandidateToKnowledge,
  promotePersonalMemoryCandidates,
} from '@agent/core/memory-promotion-workflow';
import { logger } from '@agent/core/core';
import { getRegisteredEnv } from '@agent/core/foundation';
import { getOptionValue } from './mission-cli-args.js';
import { ScriptExitError } from '../lib/harness.js';

type Print = (value: unknown) => void;

function registeredEnv(name: string): string | undefined {
  return getRegisteredEnv<string>(name) as string | undefined;
}

function reviewForCli(candidateId: string, tenantSlug?: string): MemoryPromotionReview {
  const reviews = reviewMemoryPromotionCandidate(candidateId).filter((review) =>
    tenantSlug ? review.candidate.scope?.tenant_slug === tenantSlug : true
  );
  if (reviews.length === 0) {
    throw new Error(
      `Memory promotion candidate not found: ${candidateId}${tenantSlug ? ` (tenant=${tenantSlug})` : ''}`
    );
  }
  if (reviews.length > 1) {
    const scopes = reviews
      .map((review) => review.candidate.scope?.tenant_slug || 'legacy/global')
      .join(', ');
    throw new Error(
      `[MEMORY_PROMOTION_AMBIGUOUS] candidate '${candidateId}' exists in multiple scopes: ${scopes}; use --tenant-slug <slug>`
    );
  }
  return reviews[0];
}

export function listMemoryQueue(
  filterStatus?: 'queued' | 'approved' | 'rejected' | 'promoted',
  print: Print = () => undefined
) {
  const rows = reviewMemoryPromotionQueue(filterStatus);
  if (rows.length === 0) {
    logger.info(
      filterStatus
        ? `No memory promotion candidates with status "${filterStatus}".`
        : 'No memory promotion candidates in queue.'
    );
    return;
  }
  const header = `${'CANDIDATE_ID'.padEnd(30)} ${'STATUS'.padEnd(10)} ${'DECISION'.padEnd(17)} ${'BLOCKERS'.padEnd(8)} ${'RECORDS'.padEnd(8)} ${'KIND'.padEnd(18)} ${'TIER'.padEnd(13)} SOURCE`;
  print('');
  print(header);
  print('-'.repeat(header.length + 6));
  for (const review of rows) {
    const candidate = review.candidate;
    print(
      `${review.candidate_id.padEnd(30)} ${candidate.status.padEnd(10)} ${review.review_status.padEnd(17)} ${String(review.blockers.length).padEnd(8)} ${String(review.physical_record_count).padEnd(8)} ${candidate.proposed_memory_kind.padEnd(18)} ${candidate.sensitivity_tier.padEnd(13)} ${candidate.source_ref}`
    );
  }
  print('');
}

export function showMemoryReview(
  candidateId: string,
  tenantSlug?: string,
  jsonOutput = false,
  print: Print = () => undefined
) {
  const review = reviewForCli(candidateId, tenantSlug);
  if (jsonOutput) {
    print(JSON.stringify(review, null, 2));
    return;
  }
  const candidate = review.candidate;
  print('');
  print(`Candidate: ${review.candidate_id}`);
  print(`Decision: ${review.review_status}`);
  print(`Summary: ${candidate.summary}`);
  print(`Source: ${candidate.source_type} / ${candidate.source_ref}`);
  print(`Kind: ${candidate.proposed_memory_kind} -> ${review.target_kind}`);
  print(`Target: ${review.target_path}`);
  print(`Tier: ${candidate.sensitivity_tier}`);
  print(`Scope: ${candidate.scope?.tenant_slug || 'legacy/global'}`);
  print(`Ratification required: ${review.approval_required ? 'yes' : 'no'}`);
  print(`Physical records: ${review.physical_record_count}`);
  print(
    `Audit: ${review.audit.status}${review.audit.audit_id ? ` (${review.audit.audit_id})` : ''}`
  );
  print('Evidence:');
  for (const evidence of review.evidence) {
    print(`  - [${evidence.status}] ${evidence.ref}`);
  }
  if (review.blockers.length > 0) {
    print('Blockers:');
    for (const blocker of review.blockers) print(`  - ${blocker.code}: ${blocker.detail}`);
  }
  if (review.warnings.length > 0) {
    print('Warnings:');
    for (const warning of review.warnings) print(`  - ${warning}`);
  }
  print('');
  print(
    review.review_status === 'ready_to_approve'
      ? 'Next: memory-approve <CANDIDATE_ID> --note "<reason>"'
      : review.review_status === 'ready_to_promote'
        ? 'Next: memory-promote <CANDIDATE_ID> --note "<reason>"'
        : 'Next: resolve the blockers before approval or promotion.'
  );
}

export function approveMemoryCandidate(
  candidateId: string,
  note?: string,
  tenantSlug?: string,
  print: Print = () => undefined
) {
  if (!candidateId) {
    throw new ScriptExitError(
      1,
      'Usage: mission_controller memory-approve <CANDIDATE_ID> [--tenant-slug <SLUG>] [--note <TEXT>]'
    );
  }
  try {
    const review = reviewForCli(candidateId, tenantSlug);
    assertMemoryPromotionReviewReady(review, 'approve');
    const updated = updateMemoryPromotionCandidateStatus({
      candidateId,
      status: 'approved',
      ratificationNote: note || 'Approved for promotion.',
      ...(review.candidate.scope ? { scope: review.candidate.scope } : {}),
    });
    if (!updated) throw new Error(`Memory promotion candidate not found: ${candidateId}`);
    logger.success(`✅ Memory candidate approved: ${updated.candidate_id}`);
  } catch (error) {
    throw new ScriptExitError(1, error instanceof Error ? error.message : String(error));
  }
}

export function rejectMemoryCandidate(
  candidateId: string,
  note?: string,
  tenantSlug?: string,
  allDuplicates = false,
  print: Print = () => undefined
) {
  if (!candidateId) {
    throw new ScriptExitError(
      1,
      'Usage: mission_controller memory-reject <CANDIDATE_ID> [--tenant-slug <SLUG>] [--all-duplicates] [--note <TEXT>]'
    );
  }
  try {
    const review = reviewForCli(candidateId, tenantSlug);
    if (review.duplicate_count > 0 && !allDuplicates) {
      throw new Error(
        `[MEMORY_PROMOTION_DUPLICATES] ${candidateId} has ${review.physical_record_count} physical records; re-run with --all-duplicates to reject every record in this scope.`
      );
    }
    const updated = updateMemoryPromotionCandidateStatus({
      candidateId,
      status: 'rejected',
      ratificationNote: note || 'Rejected by operator review.',
      ...(review.candidate.scope ? { scope: review.candidate.scope } : {}),
      allMatching: allDuplicates,
    });
    if (!updated) throw new Error(`Memory promotion candidate not found: ${candidateId}`);
    logger.success(`✅ Memory candidate rejected: ${updated.candidate_id}`);
  } catch (error) {
    throw new ScriptExitError(1, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Record an explicit operator override of a counterfactual rubric warn/poor
 * (IP-9). Does not mutate the simulation output — only emits a tamper-
 * evident audit event so reviewers can see who accepted the un-rubric'd
 * branch and why. Required by counterfactual-degradation-policy.json
 * for `warn` severity; forbidden for `poor` unless tenant_risk_officer
 * documents it separately.
 */
export function acceptRubricOverride(
  hypothesisOrBranchId: string,
  reason?: string,
  severity?: string,
  print: Print = () => undefined
) {
  if (!hypothesisOrBranchId) {
    throw new ScriptExitError(
      1,
      'Usage: mission_controller accept-with-override <HYPOTHESIS_OR_BRANCH_ID> --reason "<text>" [--severity warn|poor]'
    );
  }
  if (!reason) {
    throw new ScriptExitError(
      1,
      'accept-with-override requires --reason "<text>" — overrides without reasoning are not auditable.'
    );
  }
  const sev = (severity || 'warn').toLowerCase();
  if (!['warn', 'poor'].includes(sev)) {
    throw new ScriptExitError(1, '--severity must be warn or poor');
  }
  if (sev === 'poor') {
    logger.warn(
      "Override of 'poor' severity is not permitted by default per " +
        'counterfactual-degradation-policy.json; only proceed if tenant_risk_officer ' +
        'has documented the exception.'
    );
  }
  const missionId = registeredEnv('MISSION_ID') || getOptionValue('--mission-id') || '';
  const entry = auditChain.record({
    agentId: registeredEnv('KYBERION_PERSONA') || 'mission_controller',
    action: 'rubric.override_accepted',
    operation: `accept-with-override:${hypothesisOrBranchId}`,
    result: 'allowed',
    reason,
    metadata: {
      hypothesis_or_branch_id: hypothesisOrBranchId,
      severity: sev,
      mission_id: missionId || undefined,
      policy_ref: 'knowledge/product/governance/counterfactual-degradation-policy.json',
    },
    compliance: {
      framework: 'counterfactual-degradation-policy.json',
      control: `severity-${sev}-override`,
    },
  });
  logger.success(
    `✅ rubric.override_accepted recorded: ${entry.id} (severity=${sev}, branch=${hypothesisOrBranchId})`
  );
}

export async function promoteMemoryCandidate(
  candidateId: string,
  executionRole: 'mission_controller' | 'chronos_gateway' = 'mission_controller',
  note?: string,
  supersedes?: string,
  tenantSlug?: string,
  print: Print = () => undefined
) {
  if (!candidateId) {
    throw new ScriptExitError(
      1,
      'Usage: mission_controller memory-promote <CANDIDATE_ID> [--tenant-slug <SLUG>] [--execution-role <mission_controller|chronos_gateway>] [--note <TEXT>] [--supersedes <PATH_OR_ID>]'
    );
  }
  try {
    const review = reviewForCli(candidateId, tenantSlug);
    assertMemoryPromotionReviewReady(review, 'promote');
    const result = await promoteMemoryCandidateToKnowledge({
      candidateId,
      executionRole,
      ratificationNote: note,
      supersedes,
      ...(review.candidate.scope ? { scope: review.candidate.scope } : {}),
    });
    logger.success(
      `✅ Memory candidate promoted: ${result.candidate.candidate_id} -> ${result.promotedRef}`
    );
  } catch (error) {
    throw new ScriptExitError(1, error instanceof Error ? error.message : String(error));
  }
}

export async function promotePendingMemoryCandidates(
  input: {
    executionRole?: 'mission_controller' | 'chronos_gateway';
    dryRun?: boolean;
    note?: string;
    supersedes?: string;
  },
  print: Print = () => undefined
) {
  const executionRole = input.executionRole || 'mission_controller';
  const pending = listMemoryPromotionCandidates()
    .filter((row) => row.status === 'approved')
    .sort((a, b) => a.queued_at.localeCompare(b.queued_at));

  if (pending.length === 0) {
    logger.info('No approved memory candidates to promote.');
  }

  let promoted = 0;
  let failed = 0;
  if (input.dryRun && pending.length > 0) {
    logger.info(`Dry run: ${pending.length} approved memory candidate(s) would be promoted.`);
    for (const row of pending) {
      try {
        const review = reviewForCli(row.candidate_id);
        print(
          `- ${row.candidate_id} (${row.proposed_memory_kind}, ${row.sensitivity_tier}) -> ${review.target_path}`
        );
        if (review.blockers.length > 0) {
          print(`  HOLD: ${review.blockers.map((blocker) => blocker.code).join(', ')}`);
        }
      } catch (error) {
        print(
          `- ${row.candidate_id} HOLD: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  } else {
    for (const row of pending) {
      try {
        const review = reviewForCli(row.candidate_id);
        assertMemoryPromotionReviewReady(review, 'promote');
        const result = await promoteMemoryCandidateToKnowledge({
          candidateId: row.candidate_id,
          executionRole,
          ratificationNote: input.note,
          supersedes: input.supersedes,
          ...(row.scope ? { scope: row.scope } : {}),
        });
        promoted += 1;
        logger.info(`🟢 promoted ${result.candidate.candidate_id} -> ${result.promotedRef}`);
      } catch (err: any) {
        failed += 1;
        logger.warn(`⚠️ failed to promote ${row.candidate_id}: ${err?.message || err}`);
      }
    }
  }
  const autopromote = await promotePersonalMemoryCandidates({
    executionRole,
    ratificationNote: input.note,
    dryRun: input.dryRun,
  });
  if (autopromote.enabled) {
    logger.info(
      `🟣 personal autopromote: considered=${autopromote.considered}, promoted=${autopromote.promoted.length}, skipped=${autopromote.skipped.length}`
    );
  }
  logger.success(`✅ Memory bulk promotion finished. promoted=${promoted}, failed=${failed}`);
}
