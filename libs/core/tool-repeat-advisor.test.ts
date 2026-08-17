import { describe, expect, it } from 'vitest';
import { TOOL_REPEAT_THRESHOLDS, ToolRepeatAdvisor } from './tool-repeat-advisor.js';

describe('tool-repeat-advisor (DH-14)', () => {
  it('uses stable argument hashes and emits advice at [3,5,8]', () => {
    const advisor = new ToolRepeatAdvisor();
    const observations = [1, 2, 3, 4, 5, 6, 7, 8].map(() =>
      advisor.observe('system:read_file', { b: 2, a: 1 })
    );
    expect(TOOL_REPEAT_THRESHOLDS).toEqual([3, 5, 8]);
    expect(observations.map((entry) => entry.repeat_count)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(observations[2]?.advice).toContain('3 times');
    expect(observations[4]?.advice).toContain('5 times');
    expect(observations[7]?.advice).toContain('8 times');
    expect(observations[0]?.args_hash).toBe(observations[7]?.args_hash);
    expect(observations[7]?.advice).not.toContain('a: 1');
  });

  it('separates operation and arguments and can reset the execution window', () => {
    const advisor = new ToolRepeatAdvisor();
    expect(advisor.observe('system:read_file', { path: 'a' }).repeat_count).toBe(1);
    expect(advisor.observe('system:read_file', { path: 'b' }).repeat_count).toBe(1);
    expect(advisor.observe('system:read_json', { path: 'a' }).repeat_count).toBe(1);
    advisor.reset();
    expect(advisor.observe('system:read_file', { path: 'a' }).repeat_count).toBe(1);
  });
});
