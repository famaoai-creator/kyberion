import { describe, expect, it } from 'vitest';
import {
  buildIntegratedHandoffHistory,
  formatIntegratedHandoffHistory,
} from './handoff-history.js';

describe('integrated handoff history (HO-02)', () => {
  it('merges mission, lease, audit, and AI-DLC rows by correlation id', () => {
    const correlationId = 'corr-ho-02';
    const rows = buildIntegratedHandoffHistory({
      correlationId,
      missions: [
        {
          missionId: 'MSN-HO-02',
          state: {
            mission_id: 'MSN-HO-02',
            correlation_id: correlationId,
            tier: 'public',
            status: 'active',
            execution_mode: 'local',
            priority: 1,
            assigned_persona: 'builder',
            confidence_score: 1,
            git: { branch: 'test', start_commit: 'a', latest_commit: 'b', checkpoints: [] },
            history: [
              {
                ts: '2026-07-11T12:00:00.000Z',
                event: 'handoff',
                from: 'planner',
                to: 'builder',
                note: 'continue execution',
              },
            ],
          },
          aidlcState: {
            version: '1.0.0',
            mission_id: 'MSN-HO-02',
            phase: 'execution',
            attempts: [{ phase: 'execution', at: '2026-07-11T12:01:00.000Z', outcome: 'passed' }],
            updated_at: '2026-07-11T12:01:00.000Z',
          },
        },
      ],
      coordinationEvents: [
        {
          event_id: 'evt-1',
          ts: '2026-07-11T12:02:00.000Z',
          event_type: 'item_handed_off',
          item_id: 'item-1',
          actor_peer_id: 'peer-a',
          payload: { correlation_id: correlationId },
          note: 'lease transferred',
        },
      ],
      auditEntries: [
        {
          id: 'AUD-1',
          timestamp: '2026-07-11T12:03:00.000Z',
          agentId: 'operator',
          action: 'approval_gate',
          operation: 'approve',
          result: 'completed',
          correlationId,
          previousHash: 'a',
          currentHash: 'b',
        },
      ],
    });

    expect(rows.map((row) => row.source)).toEqual(['mission', 'aidlc', 'coordination', 'audit']);
    expect(rows.find((row) => row.source === 'coordination')?.refs).toContain('item:item-1');
    expect(formatIntegratedHandoffHistory(correlationId, rows)).toContain('Events: 4');
  });

  it('redacts non-public mission event contents while preserving a reference', () => {
    const rows = buildIntegratedHandoffHistory({
      correlationId: 'corr-private',
      missions: [
        {
          missionId: 'MSN-PRIVATE',
          state: {
            mission_id: 'MSN-PRIVATE',
            correlation_id: 'corr-private',
            tier: 'confidential',
            status: 'active',
            execution_mode: 'local',
            priority: 1,
            assigned_persona: 'builder',
            confidence_score: 1,
            git: { branch: 'test', start_commit: 'a', latest_commit: 'b', checkpoints: [] },
            history: [
              { ts: '2026-07-11T12:00:00.000Z', event: 'handoff', note: 'secret customer data' },
            ],
          },
        },
      ],
    });
    expect(rows[0]?.summary).toContain('confidential mission event');
    expect(rows[0]?.summary).not.toContain('secret customer data');
  });
});
