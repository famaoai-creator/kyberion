import { describe, expect, it } from 'vitest';

import { parseArgs } from './migrate_physical_namespaces.js';

describe('physical namespace migration CLI', () => {
  it('defaults to a non-mutating all-kinds dry-run', () => {
    expect(parseArgs([])).toEqual({ kind: 'all', apply: false });
  });

  it('requires an explicit apply flag and supports all record kinds', () => {
    expect(parseArgs(['--kind', 'all'])).toEqual({ kind: 'all', apply: false });
    expect(parseArgs(['--kind', 'schedule', '--apply'])).toEqual({
      kind: 'schedule',
      apply: true,
    });
  });

  it('rejects unknown migration kinds', () => {
    expect(() => parseArgs(['--kind', 'ledger'])).toThrow('Unsupported --kind: ledger');
  });
});
