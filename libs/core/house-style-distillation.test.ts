/**
 * MP-05 review phase: recurring findings become standing constraints.
 *
 * The two failure modes this guards against are opposite: promoting noise from
 * a single bad artifact, and never promoting anything so the review loop keeps
 * paying to rediscover the same defect.
 */
import { describe, expect, it } from 'vitest';
import {
  distillHouseStyleProposals,
  formatHouseStyleProposals,
  houseStyleProposalSchema,
} from './house-style-distillation.js';
import type { VisualFinding } from './visual-review.js';

function finding(criterionId: string, summary = 'looks machine-made'): VisualFinding {
  return { criterion_id: criterionId, severity: 'warning', page: 1, summary, fix: 'vary it' };
}

describe('distillHouseStyleProposals', () => {
  it('promotes a defect seen across enough distinct artifacts', () => {
    const proposals = distillHouseStyleProposals({
      history: [
        { artifact_id: 'deck-a', findings: [finding('ai-defaults')] },
        { artifact_id: 'deck-b', findings: [finding('ai-defaults')] },
        { artifact_id: 'deck-c', findings: [finding('ai-defaults')] },
      ],
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposed_constraint).toBe('machine-made-tells');
    expect(proposals[0].distinct_artifacts).toBe(3);
  });

  it('does not promote from a single noisy artifact', () => {
    // Ten findings on one deck says something about that deck, not about the
    // house style.
    const proposals = distillHouseStyleProposals({
      history: [
        {
          artifact_id: 'deck-a',
          findings: Array.from({ length: 10 }, () => finding('ai-defaults')),
        },
      ],
    });
    expect(proposals).toHaveLength(0);
  });

  it('counts artifacts rather than findings', () => {
    const proposals = distillHouseStyleProposals({
      history: [
        { artifact_id: 'deck-a', findings: [finding('overflow'), finding('overflow')] },
        { artifact_id: 'deck-b', findings: [finding('overflow')] },
      ],
      minDistinctArtifacts: 3,
    });
    expect(proposals).toHaveLength(0);
  });

  it('honours a custom threshold', () => {
    const proposals = distillHouseStyleProposals({
      history: [
        { artifact_id: 'deck-a', findings: [finding('contrast')] },
        { artifact_id: 'deck-b', findings: [finding('contrast')] },
      ],
      minDistinctArtifacts: 2,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposed_constraint).toBe('low-contrast-text');
  });

  it('does not re-propose a constraint already in force', () => {
    const proposals = distillHouseStyleProposals({
      history: [
        { artifact_id: 'a', findings: [finding('ai-defaults')] },
        { artifact_id: 'b', findings: [finding('ai-defaults')] },
        { artifact_id: 'c', findings: [finding('ai-defaults')] },
      ],
      existingConstraints: ['machine-made-tells'],
    });
    expect(proposals).toHaveLength(0);
  });

  it('ranks the most widespread defect first', () => {
    const proposals = distillHouseStyleProposals({
      history: [
        { artifact_id: 'a', findings: [finding('ai-defaults'), finding('density')] },
        { artifact_id: 'b', findings: [finding('ai-defaults'), finding('density')] },
        { artifact_id: 'c', findings: [finding('ai-defaults')] },
        { artifact_id: 'd', findings: [finding('ai-defaults')] },
      ],
      minDistinctArtifacts: 2,
    });
    expect(proposals[0].criterion_id).toBe('ai-defaults');
  });

  it('carries bounded evidence for the promotion decision', () => {
    const proposals = distillHouseStyleProposals({
      history: Array.from({ length: 8 }, (_, i) => ({
        artifact_id: `deck-${i}`,
        findings: [finding('alignment', `misaligned on deck ${i}`)],
      })),
    });
    expect(proposals[0].evidence.length).toBeGreaterThan(0);
    expect(proposals[0].evidence.length).toBeLessThanOrEqual(5);
  });

  it('produces schema-valid proposals', () => {
    const proposals = distillHouseStyleProposals({
      history: [
        { artifact_id: 'a', findings: [finding('hierarchy')] },
        { artifact_id: 'b', findings: [finding('hierarchy')] },
        { artifact_id: 'c', findings: [finding('hierarchy')] },
      ],
    });
    for (const proposal of proposals) {
      expect(houseStyleProposalSchema.safeParse(proposal).success).toBe(true);
    }
  });

  it('returns nothing for an empty history', () => {
    expect(distillHouseStyleProposals({ history: [] })).toEqual([]);
  });

  it('is deterministic for the same history', () => {
    const history = [
      { artifact_id: 'a', findings: [finding('density')] },
      { artifact_id: 'b', findings: [finding('density')] },
      { artifact_id: 'c', findings: [finding('density')] },
    ];
    expect(distillHouseStyleProposals({ history })).toEqual(
      distillHouseStyleProposals({ history })
    );
  });
});

describe('formatHouseStyleProposals', () => {
  it('says plainly when nothing recurred enough', () => {
    expect(formatHouseStyleProposals([])).toContain('no defect recurred');
  });

  it('frames results as proposals needing approval, not applied changes', () => {
    const proposals = distillHouseStyleProposals({
      history: [
        { artifact_id: 'a', findings: [finding('ai-defaults')] },
        { artifact_id: 'b', findings: [finding('ai-defaults')] },
        { artifact_id: 'c', findings: [finding('ai-defaults')] },
      ],
    });
    const rendered = formatHouseStyleProposals(proposals);
    expect(rendered).toContain('proposals');
    expect(rendered).toContain('approval');
  });
});
