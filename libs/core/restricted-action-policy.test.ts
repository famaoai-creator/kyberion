import { describe, expect, it } from 'vitest';
import {
  matchRestrictedAction,
  type RestrictedActionRule,
} from './restricted-action-policy.js';

const RULES: RestrictedActionRule[] = [
  {
    id: 'rest.financial-transfer',
    label: 'Financial transfer / payment / wire',
    patterns: [
      '\\bwire\\s+(transfer|money|funds|payment)',
      '送金|振込|支払い|決済',
    ],
  },
  {
    id: 'rest.contract-binding',
    label: 'Contract / NDA / legal binding',
    patterns: ['\\bsign\\s+(the\\s+)?(contract|agreement|nda|mou)\\b', '契約|締結'],
  },
  {
    id: 'rest.data-destructive',
    label: 'Destructive data operation',
    patterns: ['\\b(drop|truncate|delete)\\s+(the\\s+)?(database|table)\\b'],
  },
];

describe('matchRestrictedAction', () => {
  it('matches the first hit in pattern order across rules', () => {
    const m = matchRestrictedAction(
      { title: 'Wire transfer to vendor X this Friday' },
      RULES,
    );
    expect(m).toMatchObject({ id: 'rest.financial-transfer', pattern_index: 0 });
  });

  it('respects word boundaries — "rewire the dashboard" does NOT match "wire transfer"', () => {
    const m = matchRestrictedAction(
      { title: 'rewire the dashboard component to use the new theme' },
      RULES,
    );
    expect(m).toBeNull();
  });

  it('supports CJK patterns without explicit word boundaries', () => {
    const m = matchRestrictedAction(
      { title: '来週までに送金手続きを完了する' },
      RULES,
    );
    expect(m).toMatchObject({ id: 'rest.financial-transfer' });
  });

  it('case-insensitive across the haystack', () => {
    const m = matchRestrictedAction(
      { title: 'SIGN THE CONTRACT before the kickoff' },
      RULES,
    );
    expect(m).toMatchObject({ id: 'rest.contract-binding' });
  });

  it('inspects the summary in addition to the title', () => {
    const m = matchRestrictedAction(
      {
        title: 'Tidy the dashboard feature',
        summary: 'while we are at it, drop the table that nobody uses',
      },
      RULES,
    );
    expect(m).toMatchObject({ id: 'rest.data-destructive' });
  });

  it('returns null when no rule matches', () => {
    const m = matchRestrictedAction(
      { title: 'Schedule a sync with the design team' },
      RULES,
    );
    expect(m).toBeNull();
  });

  it('skips invalid regex patterns gracefully', () => {
    const broken: RestrictedActionRule[] = [
      { id: 'rest.broken', label: 'broken', patterns: ['(unclosed'] },
      { id: 'rest.financial-transfer', label: 'fin', patterns: ['\\bwire\\s+transfer\\b'] },
    ];
    const m = matchRestrictedAction({ title: 'wire transfer to X' }, broken);
    expect(m).toMatchObject({ id: 'rest.financial-transfer' });
  });
});
