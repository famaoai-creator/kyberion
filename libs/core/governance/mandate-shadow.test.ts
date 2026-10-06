import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as pathResolver from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import {
  configureMandateShadowRoot,
  evaluateBriefAgainstMandates,
  listMandateShadowRecords,
  observeMandateCoverage,
  recordMandateOutcome,
  summarizeMandateShadow,
  type MandateBriefInput,
  type MandateCatalog,
} from './mandate-shadow.js';

const NOW = new Date('2026-10-05T00:00:00.000Z');
const catalog: MandateCatalog = {
  version: '1.0.0',
  external_effect_patterns: ['publish', '本番'],
  mandates: [
    {
      id: 'test-strengthening',
      title: 'Strengthen tests',
      work_type_patterns: ['add test', 'テスト強化'],
      allowed_path_globs: ['**/*.test.ts', 'tests/**'],
      max_risk_level: 2,
      expires_at: '2027-01-01T00:00:00.000Z',
    },
  ],
};

const brief = (over: Partial<MandateBriefInput> = {}): MandateBriefInput => ({
  title: 'Add test coverage for the router',
  intent: 'add test cases',
  tier: 'public',
  scope: { in: ['libs/core/router.test.ts'] },
  gate: { riskLevel: 1 },
  ...over,
});
const evaluate = (b: MandateBriefInput, c = catalog) =>
  evaluateBriefAgainstMandates(b, { catalog: c, now: NOW });

describe('evaluateBriefAgainstMandates', () => {
  it('covers an in-scope low-risk brief', () => {
    expect(evaluate(brief())).toEqual({
      covered: true,
      mandate_id: 'test-strengthening',
      reasons: [],
    });
  });

  it('does not cover a brief with no file scope, an external effect or the personal tier', () => {
    expect(evaluate(brief({ scope: { in: ['improve things'] } })).covered).toBe(false);
    expect(evaluate(brief({ deliverables: ['publish the report'] })).covered).toBe(false);
    expect(evaluate(brief({ tier: 'personal' })).covered).toBe(false);
  });

  it('does not cover paths outside the mandate, or risk above its ceiling', () => {
    expect(
      evaluate(brief({ scope: { in: ['libs/core/router.test.ts', 'libs/core/router.ts'] } }))
        .covered
    ).toBe(false);
    expect(evaluate(brief({ gate: { riskLevel: 3 } })).covered).toBe(false);
    expect(evaluate(brief({ gate: { riskLevel: 'high' } })).covered).toBe(false);
    expect(evaluate(brief({ gate: undefined })).covered).toBe(false);
  });

  it('does not cover an unmatched work type or an expired mandate', () => {
    expect(evaluate(brief({ title: 'Rewrite the router', intent: 'rewrite' })).covered).toBe(false);
    const expired = {
      ...catalog,
      mandates: [{ ...catalog.mandates[0], expires_at: '2026-01-01T00:00:00.000Z' }],
    };
    expect(evaluate(brief(), expired).reasons[0]).toContain('expired');
  });
});

describe('mandate shadow ledger', () => {
  const root = pathResolver.shared('tmp/mandate-shadow-test');
  beforeEach(() => configureMandateShadowRoot(root));
  afterEach(() => {
    configureMandateShadowRoot(undefined);
    safeRmSync(root, { recursive: true, force: true });
  });

  it('records observations and one outcome per observed mission, and summarizes agreement', () => {
    expect(path.isAbsolute(root)).toBe(true);
    // Uses the real catalog: a docs brief inside docs/ is covered.
    const covered = observeMandateCoverage('M-1', {
      title: 'Update documentation for halt',
      scope: { in: ['docs/halt.md'] },
      gate: { riskLevel: 1 },
    });
    expect(covered?.covered).toBe(true);
    observeMandateCoverage('M-2', {
      title: 'Rewrite engine',
      scope: { in: ['libs/core/x.ts'] },
      gate: { riskLevel: 1 },
    });
    expect(recordMandateOutcome('M-9', 'approved', NOW)).toBe(false);
    expect(recordMandateOutcome('M-1', 'approved', NOW)).toBe(true);
    expect(recordMandateOutcome('M-1', 'rejected', NOW)).toBe(false);
    expect(recordMandateOutcome('M-2', 'approved', NOW)).toBe(true);

    const summary = summarizeMandateShadow(listMandateShadowRecords());
    expect(summary).toMatchObject({
      observed: 2,
      settled: 2,
      agreed: 1,
      false_positive: 0,
      missed: 1,
    });
    expect(summary.readiness).toContain('1/20');
  });

  it('flags a covered mission the operator rejected as a false positive', () => {
    observeMandateCoverage('M-3', {
      title: 'Update documentation',
      scope: { in: ['docs/a.md'] },
      gate: { riskLevel: 1 },
    });
    recordMandateOutcome('M-3', 'rejected', NOW);
    const summary = summarizeMandateShadow(listMandateShadowRecords());
    expect(summary.false_positive).toBe(1);
    expect(summary.readiness).toContain('blocked');
  });
});
