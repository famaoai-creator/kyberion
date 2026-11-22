import { describe, expect, it } from 'vitest';
import { isWorkflowDisposition, WORKFLOW_DISPOSITIONS } from './workflow-disposition.js';

describe('workflow disposition vocabulary', () => {
  it('accepts only the four card actions', () => {
    expect(WORKFLOW_DISPOSITIONS).toEqual(['retry', 'skip', 'reassign', 'accept']);
    for (const action of WORKFLOW_DISPOSITIONS) {
      expect(isWorkflowDisposition(action)).toBe(true);
    }
    expect(isWorkflowDisposition('later')).toBe(false);
    expect(isWorkflowDisposition('approve')).toBe(false);
    expect(isWorkflowDisposition('rewrite_step')).toBe(false);
  });
});
