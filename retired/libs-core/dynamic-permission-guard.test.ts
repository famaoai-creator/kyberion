import { describe, expect, it } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { dynamicPermGuard } from './dynamic-permission-guard.js';

describe('dynamic permission guard', () => {
  it('loads the governed policy and denies an unmatched role', () => {
    dynamicPermGuard.loadPolicies();

    const result = dynamicPermGuard.evaluate(
      'role-that-is-not-in-the-policy',
      pathResolver.resolve('active/archive/example.json')
    );

    expect(result).toEqual({ allowed: false });
  });
});
