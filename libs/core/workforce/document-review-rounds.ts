import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ArtifactReviewFinding } from './artifact-review.js';

const text = z.string().trim().min(1).max(4000);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const findingSchema = z
  .object({
    severity: z.enum(['blocking', 'suggestion']),
    category: text,
    description: text,
    required_action: text.optional(),
    location: text.optional(),
    semantic_scope: text,
    issue_key: text,
    reverting_fix_id: text.optional(),
  })
  .strict();
const resolutionSchema = z
  .object({
    finding_id: hash,
    artifact_sha256: hash,
    semantic_scope: text,
    after_round: z.number().int().min(1).max(5),
    disposition: z.enum(['fixed', 'contested', 'accepted_risk', 'declined']),
    evidence_refs: z.array(text).min(1).max(20),
    authority_ref: text.optional(),
    fix_id: text.optional(),
  })
  .strict();
const inputSchema = z
  .object({
    requested_reviewers: z.array(text).min(1).max(16),
    rounds: z
      .array(
        z
          .object({
            round: z.number().int().min(1).max(5),
            artifact_sha256: hash,
            reviewers: z
              .array(
                z
                  .object({
                    reviewer: text,
                    status: z.enum(['completed', 'not_run']),
                    artifact_sha256: hash,
                    findings: z.array(findingSchema).max(200),
                  })
                  .strict()
              )
              .max(16),
          })
          .strict()
      )
      .min(1)
      .max(5),
    resolutions: z.array(resolutionSchema).max(1000).optional(),
  })
  .strict();

export interface DocumentReviewRoundFinding extends ArtifactReviewFinding {
  semantic_scope: string;
  issue_key: string;
  /** Explicit relation from a reviewer; the evaluator never guesses causal churn. */
  reverting_fix_id?: string;
}
export type DocumentReviewRound = z.infer<typeof inputSchema>['rounds'][number];
export type DocumentReviewResolution = z.infer<typeof resolutionSchema>;
export type DocumentReviewRoundsInput = z.infer<typeof inputSchema>;

/** Returned only by the caller's governed evidence/approval verifier, never a reviewer. */
export interface VerifiedDocumentReviewSettlement {
  finding_id: string;
  artifact_sha256: string;
  semantic_scope: string;
  evidence_refs: string[];
  authority_ref?: string;
}
export interface DocumentReviewRoundEvaluation {
  status: 'continue' | 'converged' | 'needs_decision';
  clean: boolean;
  consecutive_clean_rounds: number;
  open_findings: Array<DocumentReviewRoundFinding & { finding_id: string; reviewer: string }>;
  reopened_finding_ids: string[];
  reasons: string[];
}

/** Location and artifact revision deliberately do not participate in finding identity. */
export function documentReviewFindingId(input: {
  reviewer: string;
  semantic_scope: string;
  issue_key: string;
}): string {
  const identity = z
    .object({ reviewer: text, semantic_scope: text, issue_key: text })
    .strict()
    .parse(input);
  return createHash('sha256')
    .update(JSON.stringify([identity.reviewer, identity.semantic_scope, identity.issue_key]))
    .digest('hex');
}

/**
 * Pure replay of at most five rounds. Resolutions are facts to verify, not grants.
 * The callback must use the existing evidence/approval boundary. Model-authored
 * status, actor labels and evidence paths alone are never settlement proof.
 * Clean is computed before this round's fixes; consecutive clean rounds must
 * inspect the same artifact. This evaluator neither writes nor approves work.
 */
export function evaluateDocumentReviewRounds(
  raw: DocumentReviewRoundsInput,
  verifySettlement?: (
    resolution: DocumentReviewResolution
  ) => VerifiedDocumentReviewSettlement | undefined
): DocumentReviewRoundEvaluation {
  const input = inputSchema.parse(raw);
  const requested = new Set(input.requested_reviewers);
  if (requested.size !== input.requested_reviewers.length)
    throw new Error('Duplicate requested reviewers');
  const resolutions = input.resolutions ?? [];
  const resolutionKeys = new Set<string>();
  for (const resolution of resolutions) {
    const key = JSON.stringify([resolution.finding_id, resolution.after_round]);
    if (resolutionKeys.has(key)) throw new Error('Duplicate finding resolution in one round');
    resolutionKeys.add(key);
    const sourceRound = input.rounds[resolution.after_round - 1];
    if (!sourceRound || sourceRound.artifact_sha256 !== resolution.artifact_sha256)
      throw new Error('Resolution artifact does not match its source round');
    if (resolution.disposition === 'fixed' && !resolution.fix_id)
      throw new Error('Fixed resolution requires fix_id');
  }
  type Entry = DocumentReviewRoundFinding & {
    finding_id: string;
    reviewer: string;
    state: 'open' | 'fixed' | 'settled';
    settled_hash?: string;
    observed_hash: string;
  };
  const findings = new Map<string, Entry>();
  const fixes = new Map<string, { finding_id: string; semantic_scope: string }>();
  const reopened = new Set<string>();
  const reasons = new Set<string>();
  let consecutive = 0;
  let clean = false;
  let previousHash: string | undefined;
  let churn = false;

  for (const [index, round] of input.rounds.entries()) {
    if (round.round !== index + 1)
      throw new Error('Review rounds must be contiguous starting at one');
    if (previousHash !== round.artifact_sha256) consecutive = 0;
    for (const finding of findings.values()) {
      if (finding.state !== 'open' && finding.settled_hash !== round.artifact_sha256) {
        if (finding.state === 'fixed') reopened.add(finding.finding_id);
        finding.state = 'open';
      }
    }
    // Only prior-round resolutions can affect the current clean verdict.
    for (const resolution of resolutions.filter((item) => item.after_round === index)) {
      const finding = findings.get(resolution.finding_id);
      if (!finding || finding.semantic_scope !== resolution.semantic_scope)
        throw new Error('Resolution refers to an unknown finding or semantic scope');
      if (resolution.disposition === 'declined') {
        if (finding.severity === 'blocking')
          reasons.add('Declining a blocking finding does not settle it');
        continue;
      }
      const verification = verifySettlement?.(resolution);
      const evidenceMatches =
        verification &&
        resolution.evidence_refs.every((ref) => verification.evidence_refs.includes(ref));
      const bound =
        verification?.finding_id === finding.finding_id &&
        verification.artifact_sha256 === round.artifact_sha256 &&
        verification.semantic_scope === finding.semantic_scope &&
        evidenceMatches;
      const authority =
        resolution.disposition !== 'accepted_risk' ||
        (resolution.authority_ref && verification?.authority_ref === resolution.authority_ref);
      if (!bound || !authority) {
        reasons.add('Settlement is missing verified current-artifact evidence or authority');
        continue;
      }
      if (resolution.disposition === 'fixed') {
        // A claimed edit cannot fix a blocker in byte-for-byte unchanged content.
        if (round.artifact_sha256 === finding.observed_hash) {
          reasons.add('A fixed finding requires a verified changed artifact revision');
          continue;
        }
        const existingFix = fixes.get(resolution.fix_id!);
        if (existingFix && existingFix.finding_id !== finding.finding_id)
          throw new Error('Duplicate fix identity');
        finding.state = 'fixed';
        finding.settled_hash = round.artifact_sha256;
        fixes.set(resolution.fix_id!, {
          finding_id: finding.finding_id,
          semantic_scope: finding.semantic_scope,
        });
      } else {
        finding.state = 'settled';
        finding.settled_hash = round.artifact_sha256;
      }
    }

    const seenReviewers = new Set<string>();
    let complete = true;
    for (const reviewer of round.reviewers) {
      if (!requested.has(reviewer.reviewer) || seenReviewers.has(reviewer.reviewer))
        throw new Error('Unknown or duplicate reviewer');
      seenReviewers.add(reviewer.reviewer);
      if (reviewer.artifact_sha256 !== round.artifact_sha256)
        throw new Error('Reviewer artifact hash mismatch');
      if (reviewer.status === 'not_run') {
        if (reviewer.findings.length > 0)
          throw new Error('A not_run reviewer cannot report findings');
        complete = false;
      }
      const seenFindings = new Set<string>();
      for (const finding of reviewer.findings) {
        const id = documentReviewFindingId({
          reviewer: reviewer.reviewer,
          semantic_scope: finding.semantic_scope,
          issue_key: finding.issue_key,
        });
        if (seenFindings.has(id)) throw new Error('Duplicate reviewer finding');
        seenFindings.add(id);
        const previous = findings.get(id);
        if (previous?.state === 'fixed') reopened.add(id);
        const severity = previous?.severity === 'blocking' ? 'blocking' : finding.severity;
        const settled =
          previous?.state === 'settled' &&
          previous.settled_hash === round.artifact_sha256 &&
          !(previous.severity === 'suggestion' && finding.severity === 'blocking');
        findings.set(id, {
          ...finding,
          severity,
          finding_id: id,
          observed_hash: round.artifact_sha256,
          reviewer: reviewer.reviewer,
          state: settled ? 'settled' : 'open',
          ...(settled ? { settled_hash: round.artifact_sha256 } : {}),
        });
        if (finding.reverting_fix_id) {
          const fix = fixes.get(finding.reverting_fix_id);
          if (fix && fix.semantic_scope === finding.semantic_scope) churn = true;
        }
      }
    }
    if (seenReviewers.size !== requested.size) complete = false;
    clean =
      complete &&
      ![...findings.values()].some(
        (finding) => finding.state === 'open' && finding.severity === 'blocking'
      );
    consecutive = clean ? consecutive + 1 : 0;
    if (!complete) reasons.add('A requested reviewer did not complete');
    previousHash = round.artifact_sha256;
  }
  const lastRound = input.rounds.at(-1)!;
  // Check final-round resolution identities without counting their fixes as clean.
  for (const resolution of resolutions.filter((item) => item.after_round === lastRound.round)) {
    const finding = findings.get(resolution.finding_id);
    if (!finding || finding.semantic_scope !== resolution.semantic_scope)
      throw new Error('Resolution refers to an unknown finding or semantic scope');
  }
  if (churn)
    reasons.add('A reported issue explicitly requires reverting a prior fix in the same scope');
  const converged = consecutive >= 2 && !churn;
  const capped = input.rounds.length >= 5;
  if (capped && !converged) reasons.add('Five-round review budget reached');
  return {
    status:
      churn || (capped && !converged) ? 'needs_decision' : converged ? 'converged' : 'continue',
    clean,
    consecutive_clean_rounds: consecutive,
    open_findings: [...findings.values()]
      .filter((finding) => finding.state === 'open')
      .map(
        ({ state: _state, settled_hash: _hash, observed_hash: _observed, ...finding }) => finding
      ),
    reopened_finding_ids: [...reopened],
    reasons: [...reasons],
  };
}
