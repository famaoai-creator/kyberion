import { describe, expect, it } from 'vitest';
import { extractTaskResultBlocks, validateTaskResult } from './task-result-contract.js';

// KP-05: task_result gained an optional `knowledge_feedback` field. These
// tests pin two things: (1) every pre-KP-05 (old-format) task_result keeps
// validating exactly as before — the field is additive-only — and (2) the
// new field is validated when present, both for well-formed and malformed
// shapes.

function baseTaskResult(overrides: Record<string, unknown> = {}) {
  return {
    summary: 'Did the thing.',
    artifacts: [{ path: 'deliverables/out.md', kind: 'markdown' }],
    verification_done: ['Checked the output.'],
    gaps: [],
    needs: [],
    ...overrides,
  };
}

describe('TaskResultSchema — knowledge_feedback (KP-05)', () => {
  it('validates an old-format task_result with no knowledge_feedback field — backward-compat regression', () => {
    const result = validateTaskResult(baseTaskResult());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.value?.knowledge_feedback).toBeUndefined();
  });

  it('accepts a fully populated knowledge_feedback object', () => {
    const result = validateTaskResult(
      baseTaskResult({
        knowledge_feedback: {
          used: ['knowledge/product/architecture/foo.md'],
          not_used: ['knowledge/product/architecture/bar.md'],
          missing_topics: ['how the widget exporter handles retries'],
        },
      })
    );
    expect(result.valid).toBe(true);
    expect(result.value?.knowledge_feedback).toEqual({
      used: ['knowledge/product/architecture/foo.md'],
      not_used: ['knowledge/product/architecture/bar.md'],
      missing_topics: ['how the widget exporter handles retries'],
    });
  });

  it('accepts knowledge_feedback with any subset of its optional keys', () => {
    const usedOnly = validateTaskResult(baseTaskResult({ knowledge_feedback: { used: ['a.md'] } }));
    expect(usedOnly.valid).toBe(true);

    const empty = validateTaskResult(baseTaskResult({ knowledge_feedback: {} }));
    expect(empty.valid).toBe(true);
  });

  it('rejects knowledge_feedback with non-string array entries', () => {
    const result = validateTaskResult(baseTaskResult({ knowledge_feedback: { used: [42] } }));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects knowledge_feedback with unknown properties (strict schema)', () => {
    const result = validateTaskResult(
      baseTaskResult({ knowledge_feedback: { used: ['a.md'], bogus_field: true } })
    );
    expect(result.valid).toBe(false);
  });

  it('rejects knowledge_feedback that is not an object', () => {
    const result = validateTaskResult(baseTaskResult({ knowledge_feedback: 'nope' }));
    expect(result.valid).toBe(false);
  });
});

describe('extractTaskResultBlocks — knowledge_feedback (KP-05)', () => {
  it('parses an old-format ```task_result``` block unchanged', () => {
    const raw = ['```task_result', JSON.stringify(baseTaskResult()), '```'].join('\n');
    const { taskResults, taskResultErrors } = extractTaskResultBlocks(raw);
    expect(taskResultErrors).toEqual([]);
    expect(taskResults).toHaveLength(1);
    expect(taskResults[0]?.knowledge_feedback).toBeUndefined();
  });

  it('parses a ```task_result``` block that includes knowledge_feedback', () => {
    const raw = [
      '```task_result',
      JSON.stringify(
        baseTaskResult({
          knowledge_feedback: { used: ['knowledge/product/foo.md'], missing_topics: ['gap topic'] },
        })
      ),
      '```',
    ].join('\n');
    const { taskResults, taskResultErrors } = extractTaskResultBlocks(raw);
    expect(taskResultErrors).toEqual([]);
    expect(taskResults).toHaveLength(1);
    expect(taskResults[0]?.knowledge_feedback).toEqual({
      used: ['knowledge/product/foo.md'],
      missing_topics: ['gap topic'],
    });
  });
});
