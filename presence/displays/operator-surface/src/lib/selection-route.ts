import { NextResponse, type NextRequest } from 'next/server';
import { readJsonObjectRequest } from '@agent/core/foundation';
import { resolveSelectionRequestViewer, SelectionAccessError } from './selection-access';
import { parseSelectionCommand } from './selection-input';
import {
  changeMissionSelection,
  changeReasoningSelection,
  getMissionSelectionSnapshot,
  getReasoningSelectionSnapshot,
} from './selection-service';
import type { SelectionTarget } from './selection-contract';

/** Scan disjoint lines and fixed literals once; never retry a greedy suffix per occurrence. */
function hasInvalidSelectionMessage(message: string): boolean {
  // Preserve the old non-dotAll behavior for all JavaScript line terminators.
  return message
    .toLowerCase()
    .split(/[\r\n\u2028\u2029]/)
    .some((line) => {
      const selectionAt = line.indexOf('selection');
      return selectionAt >= 0 && line.indexOf('invalid', selectionAt + 'selection'.length) >= 0;
    });
}

/** Errors expose stable classifications only, never raw provider/configuration details. */
function selectionFailure(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : '';
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : (message.match(/^\[(MISSION_TEAM_SELECTION_[A-Z_]+)\]/)?.[1] ?? '');
  if (error instanceof Error && error.name === 'ReasoningSelectionError')
    return NextResponse.json({ error: 'SELECTION_REJECTED' }, { status: 422 });
  if (/STALE|REVISION|CONFLICT/.test(code))
    return NextResponse.json({ error: 'STALE_SELECTION' }, { status: 409 });
  if (error instanceof SelectionAccessError)
    return NextResponse.json({ error: error.code }, { status: error.status });
  if (/NOT_FOUND/.test(code))
    return NextResponse.json({ error: 'SELECTION_NOT_FOUND' }, { status: 404 });
  if (/INVALID|ACTIVE|BLOCKED|UNAVAILABLE/.test(code) || hasInvalidSelectionMessage(message))
    return NextResponse.json({ error: 'SELECTION_REJECTED' }, { status: 422 });
  return NextResponse.json({ error: 'SELECTION_UNAVAILABLE' }, { status: 503 });
}
export async function handleSelectionRequest(
  req: NextRequest,
  target: SelectionTarget
): Promise<NextResponse> {
  const viewer = resolveSelectionRequestViewer(req);
  if (viewer instanceof NextResponse) return viewer;
  try {
    if (req.method === 'GET') {
      const snapshot =
        target.kind === 'mission'
          ? getMissionSelectionSnapshot(viewer, target.missionId!)
          : getReasoningSelectionSnapshot(viewer);
      return NextResponse.json(snapshot, { headers: { 'cache-control': 'no-store' } });
    }
    if (!req.headers.get('content-type')?.startsWith('application/json'))
      return NextResponse.json({ error: 'JSON_REQUIRED' }, { status: 415 });
    const parsed = await readJsonObjectRequest(req, 'Selection request');
    if (!parsed.ok) return NextResponse.json({ error: 'INVALID_SELECTION' }, { status: 400 });
    const command = parseSelectionCommand(parsed.body, target.kind);
    if (!command) return NextResponse.json({ error: 'INVALID_SELECTION' }, { status: 400 });
    const snapshot =
      target.kind === 'mission'
        ? await changeMissionSelection(viewer, target.missionId!, command)
        : await changeReasoningSelection(viewer, command);
    return NextResponse.json(snapshot, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return selectionFailure(error);
  }
}
