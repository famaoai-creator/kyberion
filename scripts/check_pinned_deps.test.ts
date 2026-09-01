import { describe, expect, it } from 'vitest';
import { checkPinnedDependencies } from './check_pinned_deps.js';

describe('pinned dependency checker', () => {
  it('keeps the repository package manager, overrides, and lockfile governed', () => {
    expect(checkPinnedDependencies()).toEqual([]);
  });
});
