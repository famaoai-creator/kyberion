import { describe, expect, it } from 'vitest';

import { resolvePipelineInputPlaceholders } from './pipeline-input-contract.js';

describe('pipeline input placeholder resolution', () => {
  it('uses schema-compatible values for required strings and common date patterns', () => {
    expect(resolvePipelineInputPlaceholders('{{path}}', { type: 'string', minLength: 1 })).toBe(
      'p'
    );
    expect(
      resolvePipelineInputPlaceholders('{{date}}', {
        type: 'string',
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
      })
    ).toBe('2026-01-01');
    expect(
      resolvePipelineInputPlaceholders('{{week}}', {
        type: 'string',
        pattern: '^\\d{4}-W\\d{2}$',
      })
    ).toBe('2026-W01');
  });
});
