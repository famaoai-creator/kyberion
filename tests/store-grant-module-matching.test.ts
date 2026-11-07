import { describe, expect, it } from 'vitest';
import {
  storeGrantBoundaryViolations,
  type StoreGrantBoundary,
} from './helpers/store-grant-boundary.js';

describe('literal store grant module matching', () => {
  const base = 'grant.[owner]+(literal){1}*^$|?';
  const boundary: StoreGrantBoundary = {
    implementation: `libs/core/${base}.ts`,
    issuers: new Map([['issueGrant', ['libs/core/facade.ts']]]),
    consumers: new Map(),
  };

  it.each(
    ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].map((ext) => base + ext)
  )('detects an unauthorized import of the literal module %s', (name) => {
    expect(
      storeGrantBoundaryViolations(
        boundary,
        'libs/core/untrusted.ts',
        `import { issueGrant } from '@agent/core/${name}';`
      )
    ).not.toEqual([]);
  });

  it.each(['grantXo', 'grant.owner', `${base}.json`, `prefix-${base}`])(
    'does not mistake another module %s for the grant',
    (name) => {
      expect(
        storeGrantBoundaryViolations(
          boundary,
          'libs/core/untrusted.ts',
          `import { value } from '@agent/core/${name}';`
        )
      ).toEqual([]);
    }
  );
});
