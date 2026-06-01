import { describe, expect, it } from 'vitest';

import {
  loadOnboardingFlowPolicyCatalog,
  resolveOnboardingFlowPolicy,
} from './onboarding-flow-policy.js';

describe('onboarding-flow-policy', () => {
  it('loads the canonical onboarding flow labels', () => {
    const catalog = loadOnboardingFlowPolicyCatalog();
    expect(catalog.phase_titles.identity).toBe('Identity & Purpose');
    expect(catalog.phase_titles.services).toBe('Infrastructure & Services');
    expect(catalog.phase_titles.tenants).toBe('Multi-Tenant Registration');
    expect(catalog.phase_titles.tutorial).toBe('Hands-on Tutorial');
    expect(catalog.phase_titles.summary).toBe('Summary');
  });

  it('resolves the onboarding flow policy object', () => {
    const policy = resolveOnboardingFlowPolicy();
    expect(policy.tutorial_plan_title).toBe('Onboarding Tutorial Plan');
    expect(policy.tutorial_next_step_title).toBe('Suggested next step');
    expect(policy.complete_message).toBe('Onboarding complete.');
  });
});
