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

describe('extractTaskResultBlocks — conservative contract repair', () => {
  it('does not require review when the only repair is a long summary', () => {
    const raw = [
      '```task_result',
      JSON.stringify(baseTaskResult({ summary: 'x'.repeat(900) })),
      '```',
    ].join('\n');

    const parsed = extractTaskResultBlocks(raw);
    expect(parsed.taskResults).toHaveLength(1);
    expect(parsed.taskResultErrors).toEqual([]);
    expect(parsed.taskResultRepairRequiresReview).toBe(false);
    expect(parsed.taskResultRepairs).toEqual([
      'summary truncated to the 800-character contract limit',
    ]);
  });

  it('bounds an overlong summary and marks an invalid acceptance status failed', () => {
    const raw = [
      '```task_result',
      JSON.stringify(
        baseTaskResult({
          summary: 'x'.repeat(900),
          acceptance_evidence: [
            { criterion: 'criterion', status: 'unverified', evidence: 'No executable run.' },
          ],
        })
      ),
      '```',
    ].join('\n');

    const parsed = extractTaskResultBlocks(raw);
    expect(parsed.taskResultErrors).toEqual([]);
    expect(parsed.taskResults).toHaveLength(1);
    expect(parsed.taskResults[0]?.summary).toHaveLength(800);
    expect(parsed.taskResults[0]?.acceptance_evidence?.[0]?.status).toBe('failed');
    expect(parsed.taskResultRepairRequiresReview).toBe(true);
    expect(parsed.taskResultRepairs).toEqual([
      'summary truncated to the 800-character contract limit',
      'semantic: invalid acceptance_evidence status normalized to failed',
    ]);
  });

  it('does not repair missing evidence fields into a valid result', () => {
    const raw = [
      '```task_result',
      JSON.stringify(
        baseTaskResult({
          acceptance_evidence: [{ criterion: 'criterion', status: 'unverified' }],
        })
      ),
      '```',
    ].join('\n');

    const parsed = extractTaskResultBlocks(raw);
    expect(parsed.taskResults).toHaveLength(0);
    expect(parsed.taskResultErrors[0]).toContain('task_result validation failed');
    expect(parsed.taskResultRepairs).toEqual([]);
    expect(parsed.taskResultRepairRequiresReview).toBe(false);
  });

  it('rejects prototype-bearing task_result blocks before schema processing', () => {
    const raw = [
      '```task_result',
      '{"summary":"Did the thing.","artifacts":[],"verification_done":[],"gaps":[],"needs":[],"__proto__":{"summary":"spoofed"}}',
      '```',
    ].join('\n');

    const parsed = extractTaskResultBlocks(raw);
    expect(parsed.taskResults).toHaveLength(0);
    expect(parsed.taskResultErrors[0]).toContain('dangerous JSON key');
  });
});

// XP-05: task_result gained an optional `provenance` field — which reasoning
// provider/mode actually served the delegation, and whether that required a
// failover switch. Same additive-only contract as KP-05's knowledge_feedback
// above: every pre-XP-05 task_result must keep validating unchanged, and the
// new field is validated (including rejected) when present.
describe('TaskResultSchema — provenance (XP-05)', () => {
  it('validates an old-format task_result with no provenance field — backward-compat regression', () => {
    const result = validateTaskResult(baseTaskResult());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.value?.provenance).toBeUndefined();
  });

  it('accepts a fully populated provenance object', () => {
    const result = validateTaskResult(
      baseTaskResult({
        provenance: { provider: 'codex', mode: 'codex-cli', failover: true },
      })
    );
    expect(result.valid).toBe(true);
    expect(result.value?.provenance).toEqual({
      provider: 'codex',
      mode: 'codex-cli',
      failover: true,
    });
  });

  it('accepts provenance with any subset of its optional keys', () => {
    const modeOnly = validateTaskResult(baseTaskResult({ provenance: { mode: 'claude-agent' } }));
    expect(modeOnly.valid).toBe(true);

    const empty = validateTaskResult(baseTaskResult({ provenance: {} }));
    expect(empty.valid).toBe(true);
  });

  it('rejects provenance with a non-boolean failover flag', () => {
    const result = validateTaskResult(baseTaskResult({ provenance: { failover: 'yes' } }));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects provenance with unknown properties (strict schema)', () => {
    const result = validateTaskResult(
      baseTaskResult({ provenance: { provider: 'codex', bogus_field: true } })
    );
    expect(result.valid).toBe(false);
  });

  it('rejects provenance that is not an object', () => {
    const result = validateTaskResult(baseTaskResult({ provenance: 'nope' }));
    expect(result.valid).toBe(false);
  });
});
