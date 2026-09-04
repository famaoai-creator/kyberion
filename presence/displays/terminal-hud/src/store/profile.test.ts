import { describe, expect, it } from 'vitest';
import { formatOnboardingState } from './profile.js';

describe('terminal HUD profile state boundary', () => {
  it('formats scalar fields from an object root', () => {
    expect(
      formatOnboardingState({
        name: 'operator',
        completed: true,
        nested: { ignored: true },
      })
    ).toEqual(['name: operator', 'completed: true']);
  });

  it('rejects non-object persisted roots before display projection', () => {
    expect(() => formatOnboardingState(['unexpected'])).toThrow(
      'onboarding state must be a JSON object'
    );
    expect(() => formatOnboardingState(JSON.parse('{"__proto__":{"polluted":true}}'))).toThrow(
      'onboarding state contains a dangerous JSON key'
    );
  });
});
