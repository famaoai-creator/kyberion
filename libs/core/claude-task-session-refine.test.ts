import { afterEach, describe, expect, it, vi } from 'vitest';
import { maybeRefineDocumentOutput } from './claude-task-session-executor.js';

// MO-07 Task 4.2, task-session wiring: document outputs get one rubric-driven
// refine pass; nothing else does, and failures never lose the original.

const LONG_UNSTRUCTURED = `${'The quarterly numbers were discussed at length and several follow-ups were noted. '.repeat(12)}`;
const STRUCTURED = [
  '# Quarterly Summary',
  '',
  'This report covers the full delivery status for the quarter, including the',
  'completed milestones, the open risks, and the concrete next actions the',
  'team has agreed to for the coming period. Each section below expands on',
  'one of these areas with supporting detail.',
  '',
  '## Milestones',
  '1. Shipped the deploy pipeline.',
].join('\n');

describe('maybeRefineDocumentOutput (MO-07)', () => {
  afterEach(() => {
    delete process.env.KYBERION_DRAFT_REFINE;
  });

  it('refines long document outputs when the rubric finds issues', async () => {
    const refine = vi.fn(async () => STRUCTURED);
    const outcome = await maybeRefineDocumentOutput({
      kind: 'document',
      output: LONG_UNSTRUCTURED,
      goalSummary: 'quarterly report',
      refine,
    });
    expect(refine).toHaveBeenCalledTimes(1);
    expect(outcome.refined).toBe(true);
    expect(outcome.content).toBe(STRUCTURED);
    expect(outcome.passes).toBe(1);
  });

  it('passes browser outputs through untouched', async () => {
    const refine = vi.fn();
    const outcome = await maybeRefineDocumentOutput({
      kind: 'browser',
      output: LONG_UNSTRUCTURED,
      refine,
    });
    expect(refine).not.toHaveBeenCalled();
    expect(outcome).toEqual({ content: LONG_UNSTRUCTURED, refined: false, passes: 0 });
  });

  it('is disabled by KYBERION_DRAFT_REFINE=0', async () => {
    process.env.KYBERION_DRAFT_REFINE = '0';
    const refine = vi.fn();
    const outcome = await maybeRefineDocumentOutput({
      kind: 'document',
      output: LONG_UNSTRUCTURED,
      refine,
    });
    expect(refine).not.toHaveBeenCalled();
    expect(outcome.refined).toBe(false);
  });

  it('skips short outputs where a refine pass is pure cost', async () => {
    const refine = vi.fn();
    const outcome = await maybeRefineDocumentOutput({
      kind: 'document',
      output: 'short note',
      refine,
    });
    expect(refine).not.toHaveBeenCalled();
    expect(outcome.refined).toBe(false);
  });

  it('keeps the original output when refine fails', async () => {
    const refine = vi.fn(async () => {
      throw new Error('backend down');
    });
    const outcome = await maybeRefineDocumentOutput({
      kind: 'document',
      output: LONG_UNSTRUCTURED,
      refine,
    });
    expect(outcome.refined).toBe(false);
    expect(outcome.content).toBe(LONG_UNSTRUCTURED);
  });
});
