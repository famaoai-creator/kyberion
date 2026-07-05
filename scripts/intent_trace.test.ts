import { describe, expect, it } from 'vitest';
import { formatTraceReport } from './intent_trace.js';

describe('formatTraceReport', () => {
  it('renders a trace report with the major evidence sections', () => {
    const report = formatTraceReport(
      {
        correlationId: 'corr-123',
        missionEvidence: [
          {
            missionId: 'MSN-123',
            missionPath: '/tmp/missions/MSN-123',
            state: {
              mission_id: 'MSN-123',
              tier: 'confidential',
              status: 'active',
              execution_mode: 'local',
              priority: 1,
              assigned_persona: 'worker',
              confidence_score: 0.9,
              git: { branch: 'main', start_commit: 'a', latest_commit: 'b', checkpoints: [] },
              history: [],
              intent: {
                goal_summary: 'Ship the trace view',
                success_condition: 'Expose a readable correlation timeline',
              },
            } as never,
            snapshots: [
              {
                snapshot_id: 'snap-1',
                mission_id: 'MSN-123',
                stage: 'intake',
                created_at: '2026-07-05T00:00:00.000Z',
                source: 'user_prompt',
                intent: { goal: 'Ship the trace view' },
                trace_ref: 'corr-123',
              },
            ],
            traceIds: [],
          },
        ],
        traces: [
          {
            traceId: 'corr-123',
            metadata: { missionId: 'MSN-123', startedAt: '2026-07-05T00:00:00.000Z' },
            rootSpan: {
              spanId: 'span-1',
              name: 'mission',
              startTime: '2026-07-05T00:00:00.000Z',
              status: 'ok',
              events: [{ name: 'step.started', timestamp: '2026-07-05T00:01:00.000Z' }],
              artifacts: [
                { type: 'file', path: '/tmp/result.txt', timestamp: '2026-07-05T00:02:00.000Z' },
              ],
              knowledgeRefs: [],
              children: [],
            },
          },
        ],
        journals: [
          {
            ts: '2026-07-05T00:03:00.000Z',
            event_id: 'event-1',
            event_type: 'mission_completion_requested',
            mission_id: 'MSN-123',
            status: 'enqueued',
            payload_hash: 'hash',
            correlation_id: 'corr-123',
          },
        ],
        audits: [
          {
            id: 'AUD-1',
            timestamp: '2026-07-05T00:04:00.000Z',
            agentId: 'agent-1',
            action: 'approval_gate',
            operation: 'approval_gate',
            result: 'allowed',
            reason: null,
            metadata: { correlationId: 'corr-123', intentId: 'trace-view' },
            previousHash: 'prev',
            currentHash: 'curr',
          },
        ],
        taskSessions: [
          {
            session_id: 'SES-1',
            surface: 'terminal',
            task_type: 'analysis',
            status: 'completed',
            mode: 'interactive',
            goal: {
              summary: 'Ship the trace view',
              success_condition: 'Expose a readable correlation timeline',
            },
            control: { interruptible: true, requires_approval: false, awaiting_user_input: false },
            outcome_contract: {
              outcome_id: 'out-1',
              requested_result: 'trace view',
              deliverable_kind: 'report',
              success_criteria: [],
              evidence_required: false,
              expected_artifacts: [],
              verification_method: 'self_check',
            },
            history: [],
            updated_at: '2026-07-05T00:05:00.000Z',
            payload: { intent_id: 'trace-view' },
          } as never,
        ],
        memoryMatches: [
          {
            intent_id: 'trace-view',
            context_fingerprint: {},
            contract_ref: { kind: 'task_session_policy', ref: 'trace-view' },
            execution_shape: 'task_session',
            success_rate: 0.9,
            sample_count: 3,
            last_seen: '2026-07-05T00:00:00.000Z',
          },
        ],
        candidateContracts: [
          {
            intent_id: 'trace-view',
            contract_ref: { kind: 'task_session_policy', ref: 'trace-view' },
            execution_shape: 'task_session',
            score: 0.9,
            source: 'memory',
          },
        ],
        inferredIntentIds: ['corr-123', 'trace-view'],
      },
      'en'
    );

    expect(report).toContain('Intent trace: corr-123');
    expect(report).toContain('Mission evidence');
    expect(report).toContain('Trace log');
    expect(report).toContain('Approval audit');
    expect(report).toContain('Mission journal');
    expect(report).toContain('Task sessions');
    expect(report).toContain('Intent memory');
    expect(report).toContain('trace-view');
  });
});
