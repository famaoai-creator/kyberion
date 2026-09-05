import { describe, it, expect } from 'vitest';
import {
  resolveCollaborationKind,
  isKnownEventType,
  listKnownEventTypes,
  WORKER_EVENT_COLLABORATION_KIND,
  MISSION_ORCHESTRATION_COLLABORATION_KIND,
  MISSION_TASK_COLLABORATION_KIND,
  PROCESS_WATCH_COLLABORATION_KIND,
  OPERATOR_EVENT_COLLABORATION_KIND,
} from './event-vocabulary.js';
import { WORKER_EVENT_TYPES } from './worker-event-stream.js';
import { collaborationKindFromEventType } from './agent-collaboration-events.js';

/**
 * EV-07: the mapping used to be a chain of `String.includes` guesses, so it was
 * order-dependent and silently produced 'unknown' for anything unanticipated.
 */
describe('event-vocabulary', () => {
  it('WORKER_EVENT_TYPES の全値に明示マッピングがある', () => {
    for (const eventType of WORKER_EVENT_TYPES) {
      expect(isKnownEventType(eventType)).toBe(true);
      expect(resolveCollaborationKind(eventType)).not.toBe('unknown');
    }
  });

  it('閉じた語彙は推論ではなく完全一致で解決される', () => {
    // 'mission_reconciliation_requested' contains 'reconcil', which the
    // inference rules map to 'retry' — and that happens to be right here. The
    // point is that the exact table decides, not the substring scan: assert the
    // declared value, which the table is free to change independently.
    expect(resolveCollaborationKind('mission_reconciliation_requested')).toBe(
      MISSION_ORCHESTRATION_COLLABORATION_KIND.mission_reconciliation_requested
    );
    // 'subagent_unavailable' would match the broader 'subagent' rule first if
    // inference ran; the exact table pins it to failure.
    expect(resolveCollaborationKind('subagent_unavailable')).toBe('failure');
    expect(WORKER_EVENT_COLLABORATION_KIND.subagent_unavailable).toBe('failure');
    // 'task_accepted' contains 'accept' (review) — declared explicitly.
    expect(resolveCollaborationKind('task_accepted')).toBe(
      MISSION_TASK_COLLABORATION_KIND.task_accepted
    );
  });

  it('プロセス watch の quiet は blocked、lost/expired は failure', () => {
    expect(PROCESS_WATCH_COLLABORATION_KIND.quiet).toBe('blocked');
    expect(resolveCollaborationKind('quiet')).toBe('blocked');
    expect(resolveCollaborationKind('lost')).toBe('failure');
    expect(resolveCollaborationKind('expired')).toBe('failure');
  });

  it('オペレータ通知イベントも解決できる', () => {
    expect(resolveCollaborationKind('approval_required')).toBe(
      OPERATOR_EVENT_COLLABORATION_KIND.approval_required
    );
    expect(resolveCollaborationKind('deliverable_ready')).toBe('artifact');
  });

  it('自由記述の decision 文字列は最も具体的な規則が先に当たる', () => {
    // These come from appendSupervisorEvent and are constrained by no enum.
    expect(resolveCollaborationKind('agent_runtime_prewarm_timeout')).toBe('failure');
    expect(resolveCollaborationKind('agent_runtime_prewarm_requested')).toBe('spawn');
    expect(resolveCollaborationKind('agent_runtime_restart_requested')).toBe('retry');
    expect(resolveCollaborationKind('agent_runtime_stopped')).toBe('completion');
    // Regression: 'runtime' as a spawn token made every terminal agent_runtime_*
    // decision look like a spawn.
    expect(resolveCollaborationKind('agent_runtime_shutdown_all_completed')).toBe('completion');
    expect(resolveCollaborationKind('agent_runtime_refreshed')).toBe('retry');
  });

  it('agent-runtime-events.jsonl の MISSION_* イベント名を分類する(AC-02)', () => {
    // These come from libs/core/agent-runtime-events.jsonl (`event` key) and
    // were an orphaned, unclassified source before AC-02 wired readSourceEvents
    // to read them.
    expect(resolveCollaborationKind('MISSION_PAUSED')).toBe('waiting');
    expect(resolveCollaborationKind('MISSION_CANCELLED')).toBe('failure');
    expect(resolveCollaborationKind('MISSION_WORK_REMAINS')).toBe('progress');
    expect(resolveCollaborationKind('MISSION_FINISH_REFRESH_RECOMMENDED')).toBe('review');
    // Case-insensitive: the projection lowercases before matching inference.
    expect(resolveCollaborationKind('mission_paused')).toBe('waiting');
  });

  it('空・未知の入力は unknown を返す', () => {
    expect(resolveCollaborationKind('')).toBe('unknown');
    expect(resolveCollaborationKind(undefined)).toBe('unknown');
    expect(resolveCollaborationKind('zzz_no_signal_here')).toBe('unknown');
    expect(isKnownEventType('zzz_no_signal_here')).toBe(false);
  });

  it('collaborationKindFromEventType は語彙正本に委譲している', () => {
    for (const eventType of listKnownEventTypes()) {
      expect(collaborationKindFromEventType(eventType)).toBe(resolveCollaborationKind(eventType));
    }
  });

  it('全語彙のイベント名が重複していない（マージ時の取りこぼし検知）', () => {
    const tables = [
      WORKER_EVENT_COLLABORATION_KIND,
      MISSION_ORCHESTRATION_COLLABORATION_KIND,
      MISSION_TASK_COLLABORATION_KIND,
      PROCESS_WATCH_COLLABORATION_KIND,
      OPERATOR_EVENT_COLLABORATION_KIND,
    ];
    const all = tables.flatMap((table) => Object.keys(table));
    // A collision would let the merged lookup silently shadow one vocabulary's
    // declared meaning with another's.
    expect(all.length).toBe(new Set(all).size);
    expect(listKnownEventTypes().length).toBe(all.length);
  });
});
