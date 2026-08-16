import { describe, expect, it } from 'vitest';
import {
  buildApprovalQueueItems,
  buildCostSummary,
  projectMissionHistoryItems,
} from './su-surface-data';

describe('su surface data', () => {
  it('builds mission history items from mission states and artifacts', () => {
    const missions = projectMissionHistoryItems(
      [
        {
          mission_id: 'MSN-1',
          tier: 'public',
          status: 'completed',
          execution_mode: 'local',
          priority: 1,
          assigned_persona: 'operator',
          confidence_score: 0.9,
          git: { branch: 'main', start_commit: 'a', latest_commit: 'b', checkpoints: [] },
          history: [{ ts: '2026-07-01T00:00:00.000Z', event: 'done', note: 'done' }],
          intent: {
            source_text: 'Ship the report',
            goal_summary: 'Ship the report',
            success_condition: 'The report is delivered',
          },
        } as any,
      ],
      [
        {
          artifact_id: 'ART-1',
          mission_id: 'MSN-1',
          kind: 'report',
          storage_class: 'repo',
        } as any,
      ],
      {
        limit: 10,
      }
    );
    expect(missions).toHaveLength(1);
    expect(missions[0].missionId).toBe('MSN-1');
  });

  it('builds a cost summary from history entries', () => {
    const summary = buildCostSummary({
      history: [
        {
          mission_id: 'MSN-1',
          timestamp: '2026-07-01T00:00:00.000Z',
          usage: { prompt_tokens: 100, completion_tokens: 50 },
          cost_usd: 1.5,
        },
        {
          mission_id: 'MSN-1',
          timestamp: '2026-07-01T01:00:00.000Z',
          usage: { prompt_tokens: 20, completion_tokens: 30 },
          cost_usd: 0.8,
        },
      ],
      budgetUsd: 3,
    });
    expect(summary.totalTokens).toBe(200);
    expect(summary.totalUsd).toBe(2.3);
    expect(summary.overBudget).toBe(false);
    expect(summary.remainingUsd).toBe(0.7);
    expect(summary.missionBreakdown).toHaveLength(1);
  });

  it('excludes unscoped and cross-tenant usage from a tenant cost view', () => {
    const summary = buildCostSummary({
      history: [
        {
          mission_id: 'MSN-A',
          timestamp: '2026-07-01T00:00:00.000Z',
          scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
          cost_usd: 1,
        },
        {
          mission_id: 'MSN-B',
          timestamp: '2026-07-01T00:00:00.000Z',
          scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-b' },
          cost_usd: 2,
        },
        {
          mission_id: 'MSN-A',
          timestamp: '2026-07-01T00:00:00.000Z',
          cost_usd: 4,
        },
      ],
      scopeFilter: { tenant_slugs: ['tenant-a'] },
    });

    expect(summary.totalUsd).toBe(1);
    expect(summary.entryCount).toBe(1);
  });

  it('adds only scoped provider actuals and exposes unavailable generation costs separately', () => {
    const summary = buildCostSummary({
      history: [],
      scopeFilter: { tenant_slugs: ['tenant-a'] },
      generationSettlements: [
        {
          kind: 'generation-cost-settlement',
          settlement_id: 'generation:video-a',
          job_id: 'video-a',
          action: 'generate_video',
          status: 'settled',
          currency: 'USD',
          actual_cost_usd: 1.25,
          scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
          observed_at: '2026-08-16T00:00:00.000Z',
          source: 'provider-reported',
        },
        {
          kind: 'generation-cost-settlement',
          settlement_id: 'generation:video-b',
          job_id: 'video-b',
          action: 'generate_video',
          status: 'settled',
          currency: 'USD',
          actual_cost_usd: 9,
          scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-b' },
          observed_at: '2026-08-16T00:00:00.000Z',
          source: 'provider-reported',
        },
        {
          kind: 'generation-cost-settlement',
          settlement_id: 'generation:video-pending',
          job_id: 'video-pending',
          action: 'generate_video',
          status: 'unavailable',
          currency: 'USD',
          scope: { scope_kind: 'tenant', tier: 'confidential', tenant_slug: 'tenant-a' },
          observed_at: '2026-08-16T00:00:00.000Z',
          source: 'provider-reported',
        },
      ],
    });

    expect(summary.totalUsd).toBe(1.25);
    expect(summary.entryCount).toBe(1);
    expect(summary.generation).toEqual({
      actualUsd: 1.25,
      settledJobs: 1,
      awaitingActualCost: 1,
    });
  });

  it('filters approval queue items by mission and query text', () => {
    const approvals = buildApprovalQueueItems({
      query: 'rotate',
      missionId: 'msn-1',
    });
    expect(Array.isArray(approvals)).toBe(true);
  });
});
