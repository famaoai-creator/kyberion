import { describe, it, expect } from 'vitest';
import { pathResolver } from '@agent/core';
import { safeMkdir, safeReadFile, safeWriteFile } from '@agent/core';
import {
  recordTask,
  shouldSkipResumeEntry,
  RESUME_IDEMPOTENCY_WINDOW_MS,
} from './mission-maintenance.js';

describe('shouldSkipResumeEntry (Phase B-3 idempotency)', () => {
  const now = new Date('2026-05-07T12:00:00.000Z');

  it('returns false for empty history', () => {
    expect(shouldSkipResumeEntry([], now)).toBe(false);
  });

  it('returns false when last event is not RESUME', () => {
    expect(
      shouldSkipResumeEntry([{ ts: '2026-05-07T11:59:50.000Z', event: 'CHECKPOINT' }], now)
    ).toBe(false);
  });

  it('returns true when last RESUME is within window', () => {
    expect(
      shouldSkipResumeEntry(
        [{ ts: '2026-05-07T11:59:30.000Z', event: 'RESUME' }], // 30s ago
        now
      )
    ).toBe(true);
  });

  it('returns false when last RESUME is past the window', () => {
    expect(
      shouldSkipResumeEntry(
        [{ ts: '2026-05-07T11:58:00.000Z', event: 'RESUME' }], // 2 min ago
        now
      )
    ).toBe(false);
  });

  it('returns false at exact window boundary (strictly less than)', () => {
    const exactlyOnBoundary = new Date(now.getTime() - RESUME_IDEMPOTENCY_WINDOW_MS).toISOString();
    expect(shouldSkipResumeEntry([{ ts: exactlyOnBoundary, event: 'RESUME' }], now)).toBe(false);
  });

  it('returns false on malformed timestamp', () => {
    expect(shouldSkipResumeEntry([{ ts: 'not-a-date', event: 'RESUME' }], now)).toBe(false);
  });

  it('only inspects the LAST entry, not earlier RESUMEs', () => {
    expect(
      shouldSkipResumeEntry(
        [
          { ts: '2026-05-07T11:59:30.000Z', event: 'RESUME' },
          { ts: '2026-05-07T11:59:31.000Z', event: 'CHECKPOINT' },
        ],
        now
      )
    ).toBe(false);
  });

  it('coalesces a chain of rapid RESUMEs into one', () => {
    // Simulate: orchestrator restarted 3 times in quick succession.
    // The actual call site only adds an entry when this returns false,
    // so the second and third calls would both see "last is RESUME within window".
    const history: Array<{ ts: string; event: string }> = [];
    const ts1 = new Date(now.getTime() - 50_000).toISOString();
    history.push({ ts: ts1, event: 'RESUME' }); // first one was added

    expect(shouldSkipResumeEntry(history, now)).toBe(true); // 50s ago, within window

    const muchLater = new Date(now.getTime() + 70_000); // 70s later, past window
    expect(shouldSkipResumeEntry(history, muchLater)).toBe(false);
  });

  it('honors a custom window override', () => {
    expect(
      shouldSkipResumeEntry(
        [{ ts: '2026-05-07T11:59:55.000Z', event: 'RESUME' }], // 5s ago
        now,
        2_000 // 2s window
      )
    ).toBe(false);
  });

  it('records task details into the mission state context', async () => {
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'worker';
    const missionId = 'MSN-MAINTENANCE-RECORD-TASK';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    safeMkdir(missionPath, { recursive: true });
    safeWriteFile(
      `${missionPath}/mission-state.json`,
      JSON.stringify(
        {
          mission_id: missionId,
          tier: 'public',
          status: 'active',
          execution_mode: 'delegated',
          priority: 1,
          assigned_persona: 'worker',
          confidence_score: 1,
          git: {
            branch: 'main',
            start_commit: 'start',
            latest_commit: 'latest',
            checkpoints: [],
          },
          history: [],
        },
        null,
        2
      )
    );

    await recordTask(missionId, 'Dispatched work item WIT-1', {
      next_step: 'await response',
      context_pack_id: 'CPK-TEST-1',
      context_pack_path: `${missionPath}/coordination/context-packs/CPK-TEST-1.json`,
      context_pack_summary: 'Scoped context pack summary',
      context_pack_pruning_summary: {
        budget_chars: 900,
        estimated_chars: 4800,
        kept_sections: ['scope', 'mission'],
        pruned_sections: ['knowledge_hints'],
        rollup_summary: 'pruned knowledge hints',
      },
      context_chars: 4800,
      pruned_chars: 3900,
      rollup_used: true,
      result_schema_ok: true,
      needs_count: 0,
      cognitive_route_summary: 'fast_llm, owner=agent',
      drift_watchdog_summary: 'attempts=1; repeat=0; stop=no; attention=no',
      work_item_dispatch_summary: {
        item_id: 'WIT-1',
        team_role: 'implementer',
        assignee_peer_id: 'agent-1',
        execution_mode: 'agent',
      },
    });

    const state = JSON.parse(
      safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
    );
    expect(state.context.last_action).toBe('Dispatched work item WIT-1');
    expect(state.context.next_step).toBe('await response');
    expect(state.context.context_pack_id).toBe('CPK-TEST-1');
    expect(state.context.context_pack_summary).toBe('Scoped context pack summary');
    expect(state.context.context_pack_pruning_summary.pruned_sections).toEqual(['knowledge_hints']);
    expect(state.context.context_chars).toBe(4800);
    expect(state.context.pruned_chars).toBe(3900);
    expect(state.context.rollup_used).toBe(true);
    expect(state.context.result_schema_ok).toBe(true);
    expect(state.context.needs_count).toBe(0);
    expect(state.context.work_item_dispatch_summary.drift_watchdog_summary).toBe(
      'attempts=1; repeat=0; stop=no; attention=no'
    );
    expect(state.history.at(-1)?.event).toBe('RECORD_TASK');
  });
});
