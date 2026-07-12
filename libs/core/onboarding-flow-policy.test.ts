import { describe, expect, it } from 'vitest';

import {
  loadOnboardingFlowPolicyCatalog,
  resolveOnboardingFlowPolicy,
  resolveOnboardingText,
} from './onboarding-flow-policy.js';

describe('onboarding-flow-policy', () => {
  it('loads the canonical onboarding flow labels in both locales (UX-03)', () => {
    const catalog = loadOnboardingFlowPolicyCatalog();
    expect(resolveOnboardingText(catalog.phase_titles.identity, 'en')).toBe('Identity & Purpose');
    expect(resolveOnboardingText(catalog.phase_titles.identity, 'ja')).toBe(
      'アイデンティティと目的'
    );
    expect(resolveOnboardingText(catalog.phase_titles.services, 'en')).toBe(
      'Infrastructure & Services'
    );
    expect(resolveOnboardingText(catalog.phase_titles.tenants, 'en')).toBe(
      'Multi-Tenant Registration'
    );
    expect(resolveOnboardingText(catalog.phase_titles.tutorial, 'en')).toBe('Hands-on Tutorial');
    expect(resolveOnboardingText(catalog.phase_titles.summary, 'ja')).toBe('サマリ');
  });

  it('resolves the onboarding flow policy object', () => {
    const policy = resolveOnboardingFlowPolicy();
    expect(resolveOnboardingText(policy.tutorial_plan_title, 'en')).toBe(
      'Onboarding Tutorial Plan'
    );
    expect(resolveOnboardingText(policy.tutorial_next_step_title, 'en')).toBe(
      'Suggested next step'
    );
    expect(resolveOnboardingText(policy.complete_message, 'ja')).toBe('オンボーディング完了。');
  });

  it('treats plain strings as English and falls back to en when ja is absent', () => {
    expect(resolveOnboardingText('Legacy label', 'ja')).toBe('Legacy label');
    expect(resolveOnboardingText({ en: 'Only English' }, 'ja')).toBe('Only English');
    expect(resolveOnboardingText({ en: 'Both', ja: '両方' }, 'ja')).toBe('両方');
    expect(resolveOnboardingText({ en: 'Both', ja: '両方' }, 'en')).toBe('Both');
  });
});
