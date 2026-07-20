import { z } from 'zod';
import type { VisualFinding } from './visual-review.js';

/**
 * MP-05 (review phase): turn repeated critique findings into a standing rule.
 *
 * A review loop that starts from zero every run keeps rediscovering the same
 * defect and paying for the round that finds it. Anthropic's own account of
 * this is the model: they ran a generator/evaluator loop, noticed it kept
 * flagging the same "distributional convergence" tells, and distilled those
 * into a short skill so later runs avoided them without the loop.
 *
 * This module does the counting and proposes the promotion. It deliberately
 * does not write anything: promoting a constraint changes how every future
 * artifact is produced, which is a governance decision (KM-03), not a side
 * effect of a render finishing.
 */

export const houseStyleProposalSchema = z.object({
  /** Rubric criterion the recurring findings came from. */
  criterion_id: z.string(),
  /** Constraint id to add to the brand tokens' banned_patterns. */
  proposed_constraint: z.string(),
  /** How many separate runs hit this. */
  occurrences: z.number().int().min(1),
  /** Distinct artifacts affected — one noisy deck is not a pattern. */
  distinct_artifacts: z.number().int().min(1),
  /** Verbatim finding summaries, as the evidence for the promotion. */
  evidence: z.array(z.string()).min(1),
  rationale: z.string().min(1),
});

export type HouseStyleProposal = z.infer<typeof houseStyleProposalSchema>;

export interface ReviewedArtifactRecord {
  /** Stable id for the artifact this review covered. */
  artifact_id: string;
  findings: VisualFinding[];
}

export interface DistillHouseStyleInput {
  history: ReviewedArtifactRecord[];
  /** Minimum separate artifacts before a finding counts as a pattern. */
  minDistinctArtifacts?: number;
  /** Constraints already in force, so nothing is proposed twice. */
  existingConstraints?: string[];
}

/** Two artifacts is coincidence; three is a habit worth encoding. */
const DEFAULT_MIN_DISTINCT_ARTIFACTS = 3;

/**
 * Derive a constraint id from a criterion.
 *
 * Kept deterministic and vocabulary-bound rather than model-generated, so the
 * same recurring defect always proposes the same constraint and the banned
 * pattern list cannot drift into free text.
 */
function constraintIdFor(criterionId: string): string {
  const known: Record<string, string> = {
    'ai-defaults': 'machine-made-tells',
    overflow: 'text-overflow',
    alignment: 'inconsistent-alignment',
    contrast: 'low-contrast-text',
    hierarchy: 'flat-visual-hierarchy',
    density: 'overloaded-slides',
    consistency: 'cross-slide-drift',
  };
  return known[criterionId] ?? `recurring-${criterionId}`;
}

/**
 * Find defects recurring across artifacts and propose them as house-style
 * constraints. Returns proposals only — applying one is a separate, governed
 * decision.
 */
export function distillHouseStyleProposals(input: DistillHouseStyleInput): HouseStyleProposal[] {
  const threshold = input.minDistinctArtifacts ?? DEFAULT_MIN_DISTINCT_ARTIFACTS;
  const existing = new Set(input.existingConstraints ?? []);

  const byCriterion = new Map<
    string,
    { occurrences: number; artifacts: Set<string>; evidence: string[] }
  >();

  for (const record of input.history) {
    for (const finding of record.findings) {
      const entry = byCriterion.get(finding.criterion_id) ?? {
        occurrences: 0,
        artifacts: new Set<string>(),
        evidence: [],
      };
      entry.occurrences += 1;
      entry.artifacts.add(record.artifact_id);
      // Keep a bounded sample; the promotion needs evidence, not a transcript.
      if (entry.evidence.length < 5) entry.evidence.push(finding.summary);
      byCriterion.set(finding.criterion_id, entry);
    }
  }

  const proposals: HouseStyleProposal[] = [];
  for (const [criterionId, entry] of byCriterion) {
    if (entry.artifacts.size < threshold) continue;
    const constraint = constraintIdFor(criterionId);
    if (existing.has(constraint)) continue;
    proposals.push({
      criterion_id: criterionId,
      proposed_constraint: constraint,
      occurrences: entry.occurrences,
      distinct_artifacts: entry.artifacts.size,
      evidence: entry.evidence,
      rationale: `"${criterionId}" was flagged in ${entry.artifacts.size} separate artifacts (${entry.occurrences} findings). Encoding it as a standing constraint stops the review loop rediscovering it every run.`,
    });
  }

  // Most-recurring first: that is the one worth an operator's attention.
  return proposals.sort((a, b) => b.distinct_artifacts - a.distinct_artifacts);
}

/** Render proposals for the review-phase report. */
export function formatHouseStyleProposals(proposals: HouseStyleProposal[]): string {
  if (proposals.length === 0) {
    return 'house-style distillation: no defect recurred often enough to promote';
  }
  return [
    `house-style distillation: ${proposals.length} constraint(s) proposed for promotion`,
    ...proposals.map(
      (proposal) =>
        `  - ${proposal.proposed_constraint} (from ${proposal.criterion_id}): seen in ${proposal.distinct_artifacts} artifacts\n      ${proposal.rationale}`
    ),
    '',
    'These are proposals. Adding one changes how every future artifact is produced,',
    'so promotion goes through the normal knowledge-promotion approval.',
  ].join('\n');
}
