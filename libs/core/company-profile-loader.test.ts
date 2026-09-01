import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { loadOrganizationProfileAtPath } from './organization-profile.js';

describe('organization profile path loader', () => {
  it('exposes the same governed schema boundary for explicit company candidates', () => {
    const profile = loadOrganizationProfileAtPath(
      pathResolver.knowledge('product/governance/organization-profile.json')
    );
    expect(profile.organization_id).toBe('default');
    expect(profile.name).toBe('Default Kyberion Organization Profile');
  });
});
