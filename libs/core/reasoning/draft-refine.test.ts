import { describe, expect, it, vi } from 'vitest';
import { draftRefine } from './draft-refine.js';

// MO-07 Task 4.2/4.3: rubric-seeded refine with fixture-injected critique.
const POOR_DOC = 'too short';
const GOOD_DOC = [
  '# Weekly Report',
  '',
  'This report covers the full delivery status for the week, including the',
  'completed milestones, the open risks, and the concrete next actions the',
  'team has agreed to for the coming sprint. Each section below expands on',
  'one of these areas with supporting detail.',
  '',
  '## Milestones',
  '1. Shipped the deploy pipeline.',
].join('\n');

describe('draftRefine', () => {
  it('returns immediately when the rubric is already clean', async () => {
    const refine = vi.fn();
    const outcome = await draftRefine({ kind: 'doc', content: GOOD_DOC, refine });
    expect(outcome.passes).toBe(0);
    expect(outcome.final_severity).toBe('ok');
    expect(refine).not.toHaveBeenCalled();
  });

  it('feeds rubric findings to the refine pass and accepts improvements', async () => {
    const refine = vi.fn(async (_draft: string, findings: string[]) => {
      expect(findings.join(' ')).toContain('too short');
      return GOOD_DOC;
    });
    const outcome = await draftRefine({ kind: 'doc', content: POOR_DOC, refine });
    expect(outcome.passes).toBe(1);
    expect(outcome.improved).toBe(true);
    expect(outcome.initial_severity).toBe('poor');
    expect(outcome.final_severity).toBe('ok');
    expect(outcome.content).toBe(GOOD_DOC);
  });

  it('caps refinement at two passes', async () => {
    const refine = vi.fn(async () => 'still way too short');
    const outcome = await draftRefine({ kind: 'doc', content: POOR_DOC, refine, maxPasses: 5 });
    expect(outcome.passes).toBeLessThanOrEqual(2);
    expect(refine.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('keeps the previous draft when a revision regresses the rubric', async () => {
    const mediumDoc = `# Title\n\n${'A meaningful paragraph. '.repeat(6)}`;
    const refine = vi.fn(async () => 'x'); // regression to poor
    const outcome = await draftRefine({ kind: 'doc', content: mediumDoc, refine, maxPasses: 2 });
    expect(outcome.content).toBe(mediumDoc);
    expect(outcome.improved).toBe(false);
  });

  it('survives refine failures without losing the draft', async () => {
    const refine = vi.fn(async () => {
      throw new Error('backend down');
    });
    const outcome = await draftRefine({ kind: 'doc', content: POOR_DOC, refine });
    expect(outcome.content).toBe(POOR_DOC);
    expect(outcome.passes).toBe(0);
  });
});
