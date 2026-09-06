import { describe, expect, it } from 'vitest';
import { loadSkillIndex } from './skill-index.js';

describe('skill index catalog', () => {
  it('loads the generated skill index through its schema', () => {
    const index = loadSkillIndex();

    expect(index.s).toHaveLength(index.t);
    expect(index.s.length).toBeGreaterThan(0);
    expect(index.s.every((entry) => entry.s === 'implemented')).toBe(true);
  });
});
