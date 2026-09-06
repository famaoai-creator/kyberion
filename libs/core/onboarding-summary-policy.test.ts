import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

import {
  loadOnboardingSummaryPolicyCatalog,
  resolveOnboardingSummaryPolicy,
} from './onboarding-summary-policy.js';

describe('onboarding-summary-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(
      pathResolver.rootResolve('libs/core/onboarding-summary-policy.ts'),
      { encoding: 'utf8' }
    ) as string;
    expect(source).not.toContain('FALLBACK_CATALOG');
  });

  it('loads the canonical onboarding summary labels', () => {
    const catalog = loadOnboardingSummaryPolicyCatalog();
    expect(catalog.title).toBe('Kyberion Onboarding Summary');
    expect(catalog.sections.identity).toBe('Identity');
    expect(catalog.sections.services).toBe('Services');
    expect(catalog.sections.tenants).toBe('Tenants');
    expect(catalog.sections.tutorial).toBe('Tutorial');
    expect(catalog.sections.next_steps).toBe('Next Steps');
  });

  it('resolves the summary policy object', () => {
    const policy = resolveOnboardingSummaryPolicy();
    expect(policy.empty_states.services).toBe('None captured yet');
    expect(policy.empty_states.tenants).toBe('None registered yet');
  });
});
