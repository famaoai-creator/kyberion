import { describe, expect, it } from 'vitest';
import { isMissionLookupRefusal, missionPathOrNull } from './mission-lookup.js';

const refusal = (code: string) => Object.assign(new Error(`[${code}] refused`), { code });

describe('missionPathOrNull', () => {
  it('returns the path of a mission that resolves', () => {
    expect(missionPathOrNull(() => '/repo/active/missions/public/MSN-A', 'MSN-A')).toBe(
      '/repo/active/missions/public/MSN-A'
    );
  });

  it('maps absent results (null / undefined) to null', () => {
    expect(missionPathOrNull(() => null, 'MSN-A')).toBeNull();
    expect(missionPathOrNull(() => undefined, 'MSN-A')).toBeNull();
  });

  it('treats ambiguous, not-visible and not-found lookups as absent', () => {
    for (const code of ['OWNER_AMBIGUOUS', 'OWNER_NOT_VISIBLE', 'OWNER_NOT_FOUND']) {
      expect(
        missionPathOrNull(() => {
          throw refusal(code);
        }, 'MSN-A')
      ).toBeNull();
    }
  });

  it('passes the id through and does not swallow other errors', () => {
    const seen: string[] = [];
    missionPathOrNull((id) => {
      seen.push(id);
      return null;
    }, 'MSN-B');
    expect(seen).toEqual(['MSN-B']);
    expect(() =>
      missionPathOrNull(() => {
        throw refusal('OWNER_ID_INVALID');
      }, 'MSN-A')
    ).toThrow(/OWNER_ID_INVALID/);
    expect(() =>
      missionPathOrNull(() => {
        throw new TypeError('boom');
      }, 'MSN-A')
    ).toThrow(TypeError);
  });

  it('recognizes only the lookup refusal codes', () => {
    expect(isMissionLookupRefusal(refusal('OWNER_AMBIGUOUS'))).toBe(true);
    expect(isMissionLookupRefusal(refusal('SCOPE_CONTRADICTS_OWNER'))).toBe(false);
    expect(isMissionLookupRefusal(new Error('x'))).toBe(false);
    expect(isMissionLookupRefusal(null)).toBe(false);
  });
});
