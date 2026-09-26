import { dhashBuffer } from '@agent/core/image-dhash';
import {
  MarkTargetError,
  isMarkTarget,
  resolveMarkTarget,
  type MarkTargetResolution,
  type ResolveMarkTargetOptions,
} from '@agent/core/mark-target-resolver';

/**
 * `click_ref` with a Set-of-Marks target (`mark:<n>` from vision
 * mark_elements). A DOM-backed mark becomes its `@eN` ref, so the normal ref
 * path (and its recorded-target safety checks) clicks it; any other mark is a
 * viewport coordinate in CSS pixels.
 *
 * Every mark click first hashes a fresh page screenshot against the marked
 * one. A DOM-backed mark is also tied to the snapshot its refs came from and
 * refused once the session holds a different snapshot. A point mark cannot
 * corroborate a recorded target, so high-risk or recorded-target clicks
 * refuse point marks.
 */

export { isMarkTarget };

export type BrowserMarkTarget =
  | { kind: 'ref'; ref: string; mark: MarkTargetResolution }
  | { kind: 'point'; x: number; y: number; mark: MarkTargetResolution };

export type MarkResolver = (
  target: string,
  options: ResolveMarkTargetOptions
) => Promise<MarkTargetResolution>;

export interface BrowserMarkTargetInput {
  params: Record<string, unknown>;
  sessionId: string;
  /** Id of the session's current snapshot (see browserSnapshotId). */
  currentSnapshotId?: string;
  /** Screenshot of the page right now. */
  captureScreen: () => Promise<Buffer>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Stable id of a browser snapshot: `<tab_id>@<captured_at>`. */
export function browserSnapshotId(snapshot: unknown): string | undefined {
  if (!snapshot || typeof snapshot !== 'object') return undefined;
  const { tab_id: tabId, captured_at: capturedAt } = snapshot as Record<string, unknown>;
  return typeof tabId === 'string' && typeof capturedAt === 'string' && tabId && capturedAt
    ? `${tabId}@${capturedAt}`
    : undefined;
}

function requiresCorroboration(params: Record<string, unknown>): boolean {
  return (
    Boolean(params.high_risk) ||
    ['role', 'name', 'dom_path'].some((key) => typeof params[key] === 'string')
  );
}

export async function resolveBrowserMarkTarget(
  target: string,
  input: BrowserMarkTargetInput,
  resolver: MarkResolver = resolveMarkTarget
): Promise<BrowserMarkTarget> {
  const { params } = input;
  const scale = typeof params.mark_scale === 'number' ? params.mark_scale : undefined;
  const marksId = optionalString(params.marks_id);
  let currentDhash: string;
  try {
    currentDhash = await dhashBuffer(await input.captureScreen());
  } catch (error) {
    throw new MarkTargetError(
      'MARK_STALE',
      `cannot capture the page to verify ${target}: ${(error as Error).message}`
    );
  }
  const mark = await resolver(target, {
    session_id: optionalString(params.mark_session_id) ?? input.sessionId,
    current_dhash: currentDhash,
    ...(scale !== undefined ? { scale } : {}),
    ...(marksId ? { marks_id: marksId } : {}),
  });
  if (mark.ref) {
    if (!mark.dom_snapshot_id || mark.dom_snapshot_id !== input.currentSnapshotId) {
      throw new MarkTargetError(
        'MARK_STALE',
        `mark ${mark.n} refers to ${mark.ref} of snapshot ${mark.dom_snapshot_id ?? '(none)'}, not the current snapshot; re-run snapshot and mark_elements with dom_snapshot_id`
      );
    }
    return { kind: 'ref', ref: mark.ref, mark };
  }
  if (requiresCorroboration(params)) {
    throw new MarkTargetError(
      'MARK_INVALID',
      `mark ${mark.n} is a bare point and cannot corroborate a high-risk or recorded target; use a DOM-backed mark`
    );
  }
  return { kind: 'point', x: mark.x, y: mark.y, mark };
}
