import { describe, expect, it } from 'vitest';
import { isExpressOnboarding, shouldRefuseNonInteractiveOnboarding } from './onboarding_mode.js';

describe('onboarding mode', () => {
  it('recognizes explicit express mode', () => {
    expect(isExpressOnboarding(['node', 'onboarding_wizard.js', '--express'])).toBe(true);
    expect(isExpressOnboarding(['node', 'onboarding_wizard.js'])).toBe(false);
  });

  it('only permits non-interactive defaults when explicitly requested', () => {
    expect(shouldRefuseNonInteractiveOnboarding({ interactive: false, express: false })).toBe(true);
    expect(shouldRefuseNonInteractiveOnboarding({ interactive: false, express: true })).toBe(false);
    expect(
      shouldRefuseNonInteractiveOnboarding({
        interactive: false,
        express: false,
        allowDefaults: '1',
      })
    ).toBe(false);
  });
});
