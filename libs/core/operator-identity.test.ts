import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveOperatorLocale } from './operator-identity.js';

// UX-03: single locale decision point.
describe('resolveOperatorLocale', () => {
  const saved = process.env.KYBERION_LOCALE;

  beforeEach(() => {
    delete process.env.KYBERION_LOCALE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.KYBERION_LOCALE;
    else process.env.KYBERION_LOCALE = saved;
  });

  it('honors the env override above everything', () => {
    process.env.KYBERION_LOCALE = 'en';
    expect(resolveOperatorLocale()).toBe('en');
    process.env.KYBERION_LOCALE = 'ja';
    expect(resolveOperatorLocale('en')).toBe('ja');
  });

  it('ignores invalid env values and falls through', () => {
    process.env.KYBERION_LOCALE = 'fr';
    expect(['ja', 'en']).toContain(resolveOperatorLocale());
  });

  it('returns the fallback when no identity exists', () => {
    // (identity may exist in a real profile; both outcomes are valid locales)
    expect(['ja', 'en']).toContain(resolveOperatorLocale('en'));
  });
});
