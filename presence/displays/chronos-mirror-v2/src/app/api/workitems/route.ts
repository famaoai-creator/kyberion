import { NextRequest, NextResponse } from 'next/server';
import { listWorkItems, updateWorkItem, type WorkItemStatus } from '@agent/core';
import { guardRequest, requireChronosAccess } from '../../../lib/api-guard';

export const dynamic = 'force-dynamic';

const KANBAN_STATUSES: WorkItemStatus[] = ['backlog', 'ready', 'in_progress', 'review', 'done'];

export function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'readonly');
  if (requiresAccess) return requiresAccess;
  const items = listWorkItems({}).filter((item) =>
    item.labels.some((label) => label.startsWith('mission:'))
  );
  return NextResponse.json({ ok: true, statuses: KANBAN_STATUSES, items });
}

export async function POST(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, 'localadmin');
  if (requiresAccess) return requiresAccess;
  try {
    const body = await req.json();
    const itemId = typeof body?.itemId === 'string' ? body.itemId : '';
    const status = KANBAN_STATUSES.includes(body?.status) ? (body.status as WorkItemStatus) : null;
    if (!itemId || !status) {
      return NextResponse.json({ ok: false, error: 'itemId と status が必要です' }, { status: 400 });
    }
    const updated = updateWorkItem({ itemId, status });
    return NextResponse.json({ ok: true, item: updated });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
