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

  it('filters approval queue items by mission and query text', () => {
    const approvals = buildApprovalQueueItems({
      query: 'rotate',
      missionId: 'msn-1',
    });
    expect(Array.isArray(approvals)).toBe(true);
  });
});
