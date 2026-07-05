import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import { collectIntentTraceReport, renderIntentTraceReport } from './intent.js';
import type { MissionState } from './refactor/mission-types.js';

const FIXTURE_ROOT = pathResolver.sharedTmp('intent-trace-tests');

describe('intent trace', () => {
  afterEach(() => {
    safeRmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it('joins mission, snapshot, memory, trace, and audit records by correlation id', () => {
    const correlationId = 'corr-intent-trace-001';
    const missionPath = path.join(FIXTURE_ROOT, 'missions', 'MSN-001');
    const evidencePath = path.join(missionPath, 'evidence');
    const traceDir = path.join(FIXTURE_ROOT, 'traces');
    const traceFile = path.join(traceDir, 'traces-2026-07-06.jsonl');
    const snapshotFile = path.join(evidencePath, 'intent-snapshots.jsonl');
    const deltaFile = path.join(evidencePath, 'intent-deltas.jsonl');

    safeMkdir(evidencePath, { recursive: true });
    safeMkdir(traceDir, { recursive: true });

    const missionState: MissionState = {
      mission_id: 'MSN-001',
      correlation_id: correlationId,
      origin_intent_id: 'intent-trace-demo',
      origin_utterance_ref: 'utterance-1',
      tier: 'confidential',
      status: 'active',
      execution_mode: 'local',
      priority: 10,
      assigned_persona: 'tester',
      confidence_score: 0.9,
      git: {
        branch: 'main',
        start_commit: 'abc',
        latest_commit: 'def',
        checkpoints: [],
      },
      history: [
        {
          ts: '2026-07-06T09:00:00.000Z',
          event: 'created',
          note: 'created mission',
        },
        {
          ts: '2026-07-06T09:05:00.000Z',
          event: 'started',
          from: 'planned',
          to: 'active',
          note: 'entered execution',
        },
      ],
    };

    safeWriteFile(
      snapshotFile,
      JSON.stringify({
        snapshot_id: 'snap-1',
        mission_id: 'MSN-001',
        stage: 'planning',
        kind: 'origin',
        created_at: '2026-07-06T09:01:00.000Z',
        source: 'user_prompt',
        intent: { goal: 'Deliver the private report', deliverables: ['report'] },
        trace_ref: correlationId,
      }) + '\n'
    );

    safeWriteFile(
      deltaFile,
      JSON.stringify({
        delta_id: 'delta-1',
        mission_id: 'MSN-001',
        from_snapshot: 'snap-1',
        to_snapshot: 'snap-2',
        computed_at: '2026-07-06T09:02:00.000Z',
        changes: { goal_changed: true, goal_similarity: 0.8 },
        drift_score: 0.2,
        drift_verdict: 'minor',
      }) + '\n'
    );

    safeWriteFile(
      traceFile,
      JSON.stringify({
        traceId: 'trace-1',
        rootSpan: {
          spanId: 'span-root',
          name: 'intent-trace',
          startTime: '2026-07-06T09:03:00.000Z',
          endTime: '2026-07-06T09:04:00.000Z',
          status: 'ok',
          events: [
            {
              name: 'execute',
              timestamp: '2026-07-06T09:03:30.000Z',
              attributes: { correlationId },
            },
          ],
          artifacts: [],
          knowledgeRefs: [],
          children: [],
        },
        metadata: {
          missionId: 'MSN-001',
          correlationId,
          startedAt: '2026-07-06T09:03:00.000Z',
          completedAt: '2026-07-06T09:04:00.000Z',
        },
      }) + '\n'
    );

    const report = collectIntentTraceReport(correlationId, {
      locale: 'en',
      missionRoots: [{ missionId: 'MSN-001', missionPath }],
      loadMissionState: (missionId) => (missionId === 'MSN-001' ? missionState : null),
      traceDir,
      loadMemory: () => ({
        entries: [
          {
            intent_id: 'intent-trace-demo',
            correlation_id: correlationId,
            mission_id: 'MSN-001',
            context_fingerprint: { surface: 'cli' },
            contract_ref: { kind: 'mission_command', ref: 'mission_controller' },
            execution_shape: 'mission',
            success_rate: 1,
            sample_count: 1,
            last_seen: '2026-07-06T09:06:00.000Z',
          },
        ],
      }),
      loadAuditEntries: () => [
        {
          id: 'AUD-1',
          timestamp: '2026-07-06T09:05:30.000Z',
          agentId: 'tester',
          action: 'mission',
          operation: 'start',
          result: 'completed',
          correlationId,
          previousHash: 'genesis',
          currentHash: 'hash',
        },
      ],
    });

    expect(report.missions).toHaveLength(1);
    expect(report.snapshots).toHaveLength(1);
    expect(report.deltas).toHaveLength(1);
    expect(report.memoryEntries).toHaveLength(1);
    expect(report.traces).toHaveLength(1);
    expect(report.auditEntries).toHaveLength(1);

    const rendered = renderIntentTraceReport(report, { maxRows: 50 });
    expect(rendered).toContain(`correlation_id: ${correlationId}`);
    expect(rendered).toContain('goal=[redacted]');
    expect(rendered).toContain('mission=MSN-001');
    expect(rendered).toContain('trace=trace-1');
    expect(rendered).not.toContain('/Users/');
  });
});
