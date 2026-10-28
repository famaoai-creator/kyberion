import { describe, expect, it } from 'vitest';
import {
  parseKnowledgeReuseSummary,
  summarizeKnowledgeReuse,
  type KnowledgeReuseReceipt,
} from './knowledge-reuse-contract.js';

const scope = {
  tier: 'confidential' as const,
  tenant_slug: 'acme',
  organization_id: 'org-a',
  project_id: 'p-a',
};
const sha = 'a'.repeat(64);
const receipt = (
  kind: KnowledgeReuseReceipt['kind'],
  id: string,
  overrides: Partial<KnowledgeReuseReceipt> = {}
): KnowledgeReuseReceipt => ({
  receipt_id: id.repeat(64),
  source_sha256: sha,
  kind,
  scope,
  at: '2026-10-28T00:00:00.000Z',
  ...overrides,
});

describe('revision reuse evidence', () => {
  it('never calls delivery or worker reports independently verified success', () => {
    const rows = [receipt('delivered', 'b'), receipt('worker_report_complete', 'c')];
    expect(summarizeKnowledgeReuse(rows, sha, scope)).toMatchObject({
      state: 'worker_reported',
      deliveries: 1,
      attempts: 1,
      verified_successes: 0,
      verified_success_rate: null,
      intervention_unknown: 1,
    });
  });

  it('isolates revision, tenant and project; replays count only once', () => {
    const pass = receipt('verified', 'b', { human_intervention: true });
    const rows = [
      pass,
      pass,
      receipt('verified', 'c', { source_sha256: 'f'.repeat(64) }),
      receipt('verified', 'd', { scope: { ...scope, tenant_slug: 'other' } }),
      receipt('verified', 'e', { scope: { ...scope, project_id: 'other' } }),
      receipt('verification_failed', 'f'),
      receipt('incomplete', 'a'),
    ];
    const summary = summarizeKnowledgeReuse(rows, sha, scope);
    expect(summary).toMatchObject({
      attempts: 3,
      verified_successes: 1,
      failed_checks: 1,
      verified_success_rate: 0.5,
      unconfirmed: 1,
      interventions: 1,
      intervention_unknown: 2,
    });
    expect(parseKnowledgeReuseSummary(summary)).toEqual(summary);
    expect(parseKnowledgeReuseSummary({ ...summary, verified_success_rate: 1 })).toBeUndefined();
    expect(parseKnowledgeReuseSummary({ ...summary, attempts: -1 })).toBeUndefined();
  });
});
