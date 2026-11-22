import { describe, expect, it } from 'vitest';
import { checkUnionLiteralBranches } from './check_union_literal_branches.js';

// The gate over the real checkout: every literal branch outside its owning
// module is either baselined or fails — the suite pins both directions.
describe('check_union_literal_branches', () => {
  it('passes the checkout with only baselined violations', () => {
    const { violations, unexpected } = checkUnionLiteralBranches();
    expect(unexpected).toEqual([]);
    expect(violations.length).toBeGreaterThan(0);
  });
});
