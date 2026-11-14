import { describe, expect, it } from 'vitest';
import { DOT_SUPERVISOR_STEPS } from './dot_supervisor_extensions.js';
import { DOT_EXECUTOR_SUPERVISOR_STEP } from './dot_executor_step.js';

describe('DOT_SUPERVISOR_STEPS ordering', () => {
  it('settles arbitration before the executor can claim a superseded WorkItem', () => {
    const ids = DOT_SUPERVISOR_STEPS.map((step) => step.id);
    expect(ids).toContain('dot-arbitration-settle');
    expect(ids.indexOf('dot-arbitration-settle')).toBeLessThan(
      ids.indexOf(DOT_EXECUTOR_SUPERVISOR_STEP.id)
    );
    // Outcomes judge results the executor just recorded.
    expect(ids.indexOf('dot-outcomes')).toBeGreaterThan(
      ids.indexOf(DOT_EXECUTOR_SUPERVISOR_STEP.id)
    );
  });
});
