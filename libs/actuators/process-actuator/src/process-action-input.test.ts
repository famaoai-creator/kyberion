import { describe, expect, it } from 'vitest';
import { parseProcessAction } from './process-action-input.js';

describe('process action input parser', () => {
  it('preserves valid pipeline fields after shallow shape validation', () => {
    const parsed = parseProcessAction({
      action: 'pipeline',
      params: { export_as: 'resources' },
      steps: [{ op: 'list', params: {} }],
      context: { mission_id: 'mission-1' },
    });
    expect(parsed).toEqual({
      action: 'pipeline',
      params: { export_as: 'resources' },
      steps: [{ op: 'list', params: {} }],
      context: { mission_id: 'mission-1' },
    });
  });
});
