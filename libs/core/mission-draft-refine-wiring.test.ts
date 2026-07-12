import { describe, expect, it } from 'vitest';
import { isDraftRefineCandidate } from './mission-orchestration-worker.js';

// MO-07 wiring gate: narrow by design.
describe('isDraftRefineCandidate', () => {
  const task = (over: Record<string, unknown> = {}) =>
    ({ task_id: 't1', risk: 'high', deliverable: 'evidence/report.md', ...over }) as never;

  it('accepts high-risk document deliverables from implementer roles', () => {
    expect(isDraftRefineCandidate({ teamRole: 'implementer', task: task() })).toBe(true);
    expect(
      isDraftRefineCandidate({ teamRole: 'writer', task: task({ risk: 'high_stakes' }) })
    ).toBe(true);
  });

  it('rejects reviewer/qa/planner roles and non-high risk', () => {
    expect(isDraftRefineCandidate({ teamRole: 'reviewer', task: task() })).toBe(false);
    expect(isDraftRefineCandidate({ teamRole: 'planner', task: task() })).toBe(false);
    expect(
      isDraftRefineCandidate({ teamRole: 'implementer', task: task({ risk: 'medium' }) })
    ).toBe(false);
  });

  it('only targets textual document deliverables', () => {
    expect(
      isDraftRefineCandidate({ teamRole: 'implementer', task: task({ deliverable: 'a.pptx' }) })
    ).toBe(false);
    expect(
      isDraftRefineCandidate({ teamRole: 'implementer', task: task({ deliverable: 'notes.txt' }) })
    ).toBe(true);
  });

  it('honors the kill switch env', () => {
    const saved = process.env.KYBERION_DRAFT_REFINE;
    try {
      process.env.KYBERION_DRAFT_REFINE = '0';
      expect(isDraftRefineCandidate({ teamRole: 'implementer', task: task() })).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.KYBERION_DRAFT_REFINE;
      else process.env.KYBERION_DRAFT_REFINE = saved;
    }
  });
});
