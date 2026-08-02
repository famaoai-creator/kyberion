import { NextRequest, NextResponse } from 'next/server';
import {
  getDelegationConcurrencyStats,
  listActiveDelegatedTaskRecords,
  peekPersistedDelegationChildrenRegistry,
} from '@agent/core';
import { conciergeText, resolveConciergeLocale, type ConciergeMessageKey } from '../../../lib/i18n';

export const dynamic = 'force-dynamic';

function elapsedSeconds(createdAt: string): number {
  const started = Date.parse(createdAt);
  return Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
}

export function GET(req: NextRequest) {
  try {
    const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
    const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
      conciergeText(key, locale, params);
    const activeTasks = listActiveDelegatedTaskRecords(8);
    const childRecords = peekPersistedDelegationChildrenRegistry();
    const now = Date.now();
    const liveChildRecords = childRecords.filter((record) => {
      const deadline = Date.parse(record.deadlineAt);
      return !Number.isFinite(deadline) || deadline > now;
    });
    const staleChildCount = childRecords.length - liveChildRecords.length;
    const concurrency = getDelegationConcurrencyStats();
    const queued = concurrency.global.queued;
    const state =
      activeTasks.length > 0 || liveChildRecords.length > 0
        ? 'waiting'
        : queued > 0
          ? 'queued'
          : 'ready';

    return NextResponse.json({
      ok: true,
      response_status: {
        state,
        label: t(`home.response_state.${state}` as ConciergeMessageKey),
        next_action: t(`home.response_next_action.${state}` as ConciergeMessageKey),
        active_count: activeTasks.length,
        queued_count: queued,
        stale_child_count: staleChildCount,
        active_tasks: activeTasks.map((task) => ({
          delegation_id: task.delegation_id,
          mission_id: task.mission_id,
          task_id: task.task_id,
          backend_name: task.backend_name,
          elapsed_seconds: elapsedSeconds(task.created_at),
        })),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
