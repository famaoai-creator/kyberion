import { describe, expect, it } from 'vitest';
import { parseSlackOnboardingAction } from './slack-onboarding.js';

describe('Slack onboarding action boundary', () => {
  it('accepts the typed payload emitted by onboarding blocks', () => {
    expect(
      parseSlackOnboardingAction(
        JSON.stringify({
          channel: 'C123',
          threadTs: '1710000000.000100',
          field: 'language',
          answer: '日本語',
        })
      )
    ).toEqual({
      channel: 'C123',
      threadTs: '1710000000.000100',
      field: 'language',
      answer: '日本語',
    });
  });

  it('rejects malformed, wrong-shaped, or prototype-bearing payloads', () => {
    expect(() => parseSlackOnboardingAction('[]')).toThrow(/JSON object/u);
    expect(() =>
      parseSlackOnboardingAction('{"channel":"C123","threadTs":"1710000","field":"unknown"}')
    ).toThrow(/invalid channel, threadTs, or field/u);
    expect(() =>
      parseSlackOnboardingAction(
        '{"channel":"C123","threadTs":"1710000","field":"name","answer":{"x":1}}'
      )
    ).toThrow(/answer must be a string/u);
    expect(() =>
      parseSlackOnboardingAction(
        '{"channel":"C123","threadTs":"1710000","field":"name","__proto__":{}}'
      )
    ).toThrow(/dangerous JSON key/u);
  });
});
