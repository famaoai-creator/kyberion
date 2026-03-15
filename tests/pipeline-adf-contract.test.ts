import { describe, expect, it } from 'vitest';
import { derivePipelineStatus, safeReadFile, validatePipelineAdf } from '../libs/core/index.js';

describe('Pipeline ADF contract', () => {
  it('accepts the canonical JSON pipeline shape used by runtime pipelines', () => {
    const content = safeReadFile('pipelines/vital-check.json', { encoding: 'utf8' }) as string;
    const pipeline = validatePipelineAdf(JSON.parse(content));

    expect(pipeline.action).toBe('pipeline');
    expect(pipeline.steps.length).toBeGreaterThan(0);
    expect(pipeline.steps[0]?.op).toBe('system:log');
  });

  it('rejects malformed pipeline definitions', () => {
    expect(() => validatePipelineAdf({ steps: [{ params: {} }] })).toThrow(/Invalid pipeline ADF/);
  });

  it('derives a failed pipeline status from step failures', () => {
    expect(derivePipelineStatus([{ op: 'x', status: 'success' }])).toBe('succeeded');
    expect(
      derivePipelineStatus([
        { op: 'x', status: 'success' },
        { op: 'y', status: 'failed', error: 'boom' }
      ])
    ).toBe('failed');
  });
});
