import { describe, expect, it } from 'vitest';
import { checkCoreModulePlacement, type CorePlacementPolicy } from './check_module_boundaries.js';

const policy: CorePlacementPolicy = {
  root_modules: {
    'secure-io.ts': { responsibility: 'Governed I/O', reason: 'Security bootstrap boundary' },
  },
  domain_roles: { intent: 'Intent formation and reconciliation' },
};

describe('exhaustive core ownership', () => {
  it('accepts reviewed boundaries and owned domains without treating tests or declarations as runtime modules', () => {
    expect(
      checkCoreModulePlacement(
        [
          'libs/core/secure-io.ts',
          'libs/core/intent/parser.ts',
          'libs/core/legacy.test.ts',
          'libs/core/types.d.ts',
        ],
        policy
      )
    ).toEqual([]);
  });
  it('rejects a new unclassified root module and domain', () => {
    expect(
      checkCoreModulePlacement(
        [
          'libs/core/secure-io.ts',
          'libs/core/intent/parser.ts',
          'libs/core/misc.ts',
          'libs/core/unknown/new.ts',
        ],
        policy
      )
    ).toEqual(['unclassified core domain: unknown', 'unclassified core root module: misc.ts']);
  });
  it('rejects stale root exceptions, stale domains and missing policy', () => {
    expect(checkCoreModulePlacement([], policy)).toEqual([
      'stale core domain classification: intent',
      'stale core root classification: secure-io.ts',
    ]);
    expect(checkCoreModulePlacement([], undefined)).toEqual(['core placement policy is missing']);
  });
  it('requires a concrete retention reason and covers native assets', () => {
    expect(
      checkCoreModulePlacement(['secure-io.ts', 'intent/native.swift', 'loose.py'], {
        ...policy,
        root_modules: { 'secure-io.ts': { responsibility: 'I/O', reason: ' ' } },
      })
    ).toEqual([
      'unclassified core root module: loose.py',
      'unclassified core root module: secure-io.ts',
    ]);
  });
});
