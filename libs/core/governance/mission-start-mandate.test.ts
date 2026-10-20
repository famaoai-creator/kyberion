import { describe, expect, it } from 'vitest';
import { evaluateMissionStartMandate, type MandateCatalog } from './mandate-shadow.js';

const now = new Date('2026-10-20T00:00:00Z');
const authority = {
  tenant_slug: 'acme',
  status: 'active' as const,
  max_cost: 100,
  currency: 'JPY',
  allowed_external_effects: ['payment'],
};
const catalog: MandateCatalog = {
  version: '1',
  external_effect_patterns: ['payment'],
  mandates: [
    {
      id: 'finance-review',
      title: 'Finance review',
      work_type_patterns: ['invoice review'],
      allowed_path_globs: ['docs/**'],
      max_risk_level: 2,
      expires_at: '2027-01-01T00:00:00Z',
      authority,
    },
  ],
};
const facts = {
  work_type: 'invoice review with payment proposal',
  paths: ['docs/invoices.md'],
  estimated_cost: 50,
  currency: 'JPY',
  external_effects: ['payment'],
  risk_level: 1,
};
const input = { tenant_slug: 'acme', mandate_id: 'finance-review', facts };
const evaluate = (over = {}, c = catalog) =>
  evaluateMissionStartMandate({ ...input, ...over }, { catalog: c, now });

describe('internal mission admission mandate', () => {
  it('admits internal planning with explicitly scoped proposed effects, without authorizing a tool effect', () => {
    expect(evaluate()).toEqual({ covered: true, mandate_id: 'finance-review', reasons: [] });
    expect(Object.keys(evaluate())).not.toContain('permitId');
  });
  it('holds shadow-only, revoked, expired and cross-tenant authority', () => {
    for (const c of [
      { ...catalog, mandates: [{ ...catalog.mandates[0]!, authority: undefined }] },
      {
        ...catalog,
        mandates: [
          { ...catalog.mandates[0]!, authority: { ...authority, status: 'revoked' as const } },
        ],
      },
      { ...catalog, mandates: [{ ...catalog.mandates[0]!, expires_at: now.toISOString() }] },
    ])
      expect(evaluate({}, c).covered).toBe(false);
    expect(evaluate({ tenant_slug: 'other' }).covered).toBe(false);
    expect(evaluate({ mandate_id: 'other' }).covered).toBe(false);
    expect(evaluate({ tenant_slug: 'shared' }).covered).toBe(false);
  });
  it.each([
    undefined,
    {},
    { ...facts, estimated_cost: NaN },
    { ...facts, estimated_cost: 101 },
    { ...facts, currency: 'USD' },
    { ...facts, external_effects: ['send_email'] },
    { ...facts, external_effects: undefined },
    { ...facts, work_type: 'other' },
    { ...facts, risk_level: 3 },
    { ...facts, paths: ['scripts/pay.ts'] },
    { ...facts, paths: ['docs/../secrets.md'] },
    { ...facts, paths: ['docs/a.md', 'secret file.md'] },
    { ...facts, paths: ['docs/**'] },
    { ...facts, paths: [] },
  ])('holds missing/unknown/outside-scope facts: %j', (bad) => {
    expect(evaluate({ facts: bad }).covered).toBe(false);
  });
});
