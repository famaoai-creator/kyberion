import { NextRequest, NextResponse } from 'next/server';
import { listActiveDelegatedTaskRecords } from '@agent/core/delegated-task-observability';
import {
  getDelegationConcurrencyStats,
  peekPersistedDelegationChildrenRegistry,
} from '@agent/core/mission/delegation-concurrency';
import { withExecutionContext } from '@agent/core/authority';
import { tryResolveOwnerScope } from '@agent/core/owner-scope';
import { conciergeText, resolveConciergeLocale, type ConciergeMessageKey } from '../../../lib/i18n';
import {
  delegatedTasksForSelection,
  type DelegatedMissionScope,
} from '../../../lib/response-status-scope';
import { resolveConciergeSelectedViewer } from '../../../lib/selected-tenant';
import { conciergeErrorResponse } from '../../../lib/viewer-context';

export const dynamic = 'force-dynamic';

function elapsedSeconds(createdAt: string): number {
  const started = Date.parse(createdAt);
  return Number.isFinite(started) ? Math.max(0, Math.floor((Date.now() - started) / 1000)) : 0;
}

function missionScope(missionId: string): DelegatedMissionScope | null {
  try {
    const scope = tryResolveOwnerScope({ kind: 'mission', id: missionId });
    return scope ? { tenant: scope.tenant, tier: scope.tier } : null;
  } catch {
    return null;
  }
}

/**
 * Delegated tasks of the selected company only (attributed through each
 * task's mission). The child-process registry and the queue carry no tenant,
 * so their host-wide counts are reported only to all-company viewers.
 */
export function GET(req: NextRequest) {
  const resolved = resolveConciergeSelectedViewer(req);
  if (resolved.response) return resolved.response;
  try {
    const locale = resolveConciergeLocale(req.headers.get('accept-language') || undefined);
    const t = (key: ConciergeMessageKey, params?: Record<string, string | number>) =>
      conciergeText(key, locale, params);
    const activeTasks = withExecutionContext('sovereign_concierge', () =>
      delegatedTasksForSelection(
        listActiveDelegatedTaskRecords(8),
        resolved.selection,
        resolved.viewer,
        missionScope
      )
    );
    const hostWide = resolved.viewer.tenantSlugs === 'all';
    const childRecords = hostWide ? peekPersistedDelegationChildrenRegistry() : [];
    const now = Date.now();
    const liveChildRecords = childRecords.filter((record) => {
      const deadline = Date.parse(record.deadlineAt);
      return !Number.isFinite(deadline) || deadline > now;
    });
    const staleChildCount = childRecords.length - liveChildRecords.length;
    const queued = hostWide ? getDelegationConcurrencyStats().global.queued : 0;
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
    return conciergeErrorResponse(error, 500);
  }
}
