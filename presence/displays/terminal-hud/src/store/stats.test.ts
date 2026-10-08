import { describe, expect, it } from 'vitest';
import { countUsageByKind } from './stats.js';

describe('terminal HUD usage counter', () => {
  it('counts usage-ledger records by resource_kind', () => {
    expect(
      countUsageByKind([
        { resource_kind: 'llm' },
        { resource_kind: 'llm' },
        { resource_kind: 'saas' },
        {},
      ])
    ).toEqual([
      { kind: 'llm', count: 2 },
      { kind: 'saas', count: 1 },
      { kind: 'other', count: 1 },
    ]);
  });
});
