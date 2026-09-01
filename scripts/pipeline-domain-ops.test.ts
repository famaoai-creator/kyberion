import { describe, expect, it } from 'vitest';
import { parseInlineOnboardingInput, runInlineProposalBriefParse } from './pipeline-domain-ops.js';

describe('pipeline domain JSON input boundaries', () => {
  it('accepts object onboarding input from JSON text and values', () => {
    expect(parseInlineOnboardingInput('{"identity":{"name":"Operator"}}')).toEqual({
      identity: { name: 'Operator' },
    });
    expect(parseInlineOnboardingInput({ identity: { name: 'Operator' } })).toEqual({
      identity: { name: 'Operator' },
    });
  });

  it.each(['[]', 'null', '"text"'])('rejects non-object onboarding input %s', (raw) => {
    expect(() => parseInlineOnboardingInput(raw)).toThrow('onboarding input must be a JSON object');
  });

  it('rejects dangerous keys before onboarding effects', () => {
    expect(() =>
      parseInlineOnboardingInput('{"identity":{"__proto__":{"polluted":true}}}')
    ).toThrow('onboarding input contains a dangerous JSON key');
  });

  it('rejects dangerous external proposal JSON before pipeline effects', () => {
    expect(() =>
      runInlineProposalBriefParse(
        { produces: 'proposal' } as never,
        { input: '{"nested":{"prototype":{"polluted":true}}}' },
        { tenant_slug: 'demo' }
      )
    ).toThrow('deck_brief_raw contains a dangerous JSON key');
  });
});
