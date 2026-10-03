import { describe, expect, it } from 'vitest';
import { OwnerScopeError } from './owner-scope.js';
import {
  isMissionLookupRefusal,
  missionPathOrNull,
  readOrNullOnMissionRefusal,
} from './mission-lookup.js';

const refusal = (code: string) => Object.assign(new Error(`[${code}] refused`), { code });

describe('readOrNullOnMissionRefusal', () => {
  it('returns the read value, or null when the mission is ambiguous or not visible', () => {
    expect(readOrNullOnMissionRefusal(() => ({ status: 'active' }))).toEqual({ status: 'active' });
    for (const code of ['OWNER_AMBIGUOUS', 'OWNER_NOT_VISIBLE']) {
      expect(
        readOrNullOnMissionRefusal(() => {
          throw refusal(code);
        })
      ).toBeNull();
    }
  });

  it('rethrows other errors', () => {
    expect(() =>
      readOrNullOnMissionRefusal(() => {
        throw new TypeError('boom');
      })
    ).toThrow(TypeError);
  });
});

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

  it('rethrows an invalid-id error that carries no refusal code', () => {
    expect(() =>
      missionPathOrNull(() => {
        throw new Error('[path-resolver] invalid mission id');
      }, 'bad id')
    ).toThrow(/invalid mission id/);
  });

  it('agrees with the real OwnerScopeError codes', () => {
    const make = (code: ConstructorParameters<typeof OwnerScopeError>[0]['code']) =>
      new OwnerScopeError({
        code,
        owner: { kind: 'mission', id: 'MSN-A' },
        what: 'x',
        why: 'y',
        remedy: 'z',
      });
    expect(isMissionLookupRefusal(make('OWNER_NOT_FOUND'))).toBe(true);
    expect(isMissionLookupRefusal(make('OWNER_AMBIGUOUS'))).toBe(true);
    expect(isMissionLookupRefusal(make('OWNER_ID_INVALID'))).toBe(false);
    expect(isMissionLookupRefusal(make('SCOPE_CONTRADICTS_OWNER'))).toBe(false);
  });

  it('recognizes only the lookup refusal codes', () => {
    expect(isMissionLookupRefusal(refusal('OWNER_AMBIGUOUS'))).toBe(true);
    expect(isMissionLookupRefusal(refusal('SCOPE_CONTRADICTS_OWNER'))).toBe(false);
    expect(isMissionLookupRefusal(new Error('x'))).toBe(false);
    expect(isMissionLookupRefusal(null)).toBe(false);
  });
});
