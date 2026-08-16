import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import {
  applyKnowledgeRankingWeightProposal,
  proposeKnowledgeRankingWeightRecalculation,
} from './knowledge-weight-recalculation.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('proposeKnowledgeRankingWeightRecalculation', () => {
  const root = pathResolver.sharedTmp(`knowledge-weight-proposal/${process.pid}`);
  const usageBase = `${root}/usage.json`;
  const usagePath = path.join(
    path.dirname(pathResolver.rootResolve(usageBase)),
    'tenants',
    'tenant-a',
    'usage.json'
  );
  const envKey = 'KYBERION_KNOWLEDGE_USAGE_PATH';
  let originalUsagePath: string | undefined;

  beforeEach(() => {
    originalUsagePath = process.env[envKey];
    process.env[envKey] = usageBase;
    safeRmSync(root, { recursive: true, force: true });
    safeMkdir(root, { recursive: true });
  });

  afterEach(() => {
    safeRmSync(root, { recursive: true, force: true });
    if (originalUsagePath === undefined) delete process.env[envKey];
    else process.env[envKey] = originalUsagePath;
  });

  it('proposes a bounded tenant override without mutating governance JSON', () => {
    safeWriteFile(
      usagePath,
      JSON.stringify([
        {
          document_path: 'knowledge/confidential/tenant-a/runbook.md',
          delivered_count: 30,
          used_count: 24,
          not_used_count: 6,
          occurrences: 30,
          last_seen: '2026-08-17T00:00:00.000Z',
        },
      ])
    );

    const proposal = proposeKnowledgeRankingWeightRecalculation({
      scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
      min_feedback_events: 20,
      persist: true,
    });

    expect(proposal.status).toBe('proposed');
    expect(proposal.approval_required).toBe(true);
    expect(proposal.sample.feedback_events).toBe(30);
    expect(proposal.proposed_weights.usage_yield).toBe(6.8);
    expect(proposal.output_path).toContain(
      '/active/shared/runtime/feedback-loop/tenants/tenant-a/'
    );
  });

  it('keeps current weights when feedback is insufficient', () => {
    const proposal = proposeKnowledgeRankingWeightRecalculation({
      scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
      min_feedback_events: 20,
      persist: false,
    });
    expect(proposal.status).toBe('insufficient_data');
    expect(proposal.proposed_weights).toEqual(proposal.current_weights);
  });

  it('requires a proposed, tenant-scoped record and explicit steward approval', () => {
    const proposal = proposeKnowledgeRankingWeightRecalculation({
      scope: { tier: 'confidential', tenant_slug: 'tenant-a' },
      min_feedback_events: 1,
      persist: false,
    });
    expect(() =>
      applyKnowledgeRankingWeightProposal({
        proposal,
        approval_ref: 'approval:weight-test',
        approved_by: 'human:knowledge-steward',
        dry_run: true,
      })
    ).toThrow(/proposal status 'insufficient_data'/);
  });
});
