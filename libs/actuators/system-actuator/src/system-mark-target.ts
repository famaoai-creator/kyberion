import { randomUUID } from 'node:crypto';
import {
  MarkTargetError,
  loadMarks,
  resolveMarkTarget,
  type MarkTargetResolution,
  type ResolveMarkTargetOptions,
} from '@agent/core/mark-target-resolver';
import { dhashFile } from '@agent/core/image-dhash';
import { pathResolver } from '@agent/core/path-resolver';
import { createScreenCaptureBridge } from '@agent/core/screen-capture-bridge';
import { safeLstat, safeRmSync } from '@agent/core/secure-io';

/**
 * Screen coordinates for system clicks addressed by a Set-of-Marks target.
 * An explicit coordinate always wins; `target_mark` (`mark:<n>` from vision
 * mark_elements) is resolved only when no coordinate is given, into logical
 * points (the marks' display scale is applied by the resolver).
 *
 * A mark is clicked only after the current screen is compared with the marked
 * screenshot, always through a fresh capture of the marks' display by the
 * governed screen-capture bridge (hashed, then deleted). A caller-supplied
 * hash is never trusted: mark_elements returns the marked image's hash, so
 * echoing it back would defeat the staleness check. Marks from a secondary
 * display are shifted by its recorded origin, and refused when that origin is
 * unknown.
 */

export interface SystemMarkTargetInput {
  coordinate?: { x: number; y: number };
  x?: unknown;
  y?: unknown;
  target_mark?: unknown;
  mark_session_id?: unknown;
  marks_id?: unknown;
}

export type MarkResolver = (
  target: string,
  options: ResolveMarkTargetOptions
) => Promise<MarkTargetResolution>;

/** dHash of what the given display shows right now. */
export type CurrentScreenHasher = (request: { display_index?: number }) => Promise<string>;

export interface SystemMarkTargetDeps {
  resolver?: MarkResolver;
  hashCurrentScreen?: CurrentScreenHasher;
  /** Display the stored marks came from (defaults to the session's saved marks). */
  markedDisplayIndex?: (sessionId: string) => number | undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function explicitCoordinate(input: SystemMarkTargetInput): { x: number; y: number } | undefined {
  if (input.coordinate) return input.coordinate;
  const given = (value: unknown) => value !== undefined && value !== null;
  if (!given(input.x) && !given(input.y)) return undefined;
  return { x: Number(input.x || 0), y: Number(input.y || 0) };
}

/** Throwaway capture path: unique per check, removed even when capture throws after writing. */
export function markCheckCapturePath(): string {
  return pathResolver.sharedTmp(`mark-target-checks/${randomUUID()}.png`);
}

export const hashCurrentScreen: CurrentScreenHasher = async ({ display_index }) => {
  const savePath = markCheckCapturePath();
  let captured: string | undefined;
  try {
    const capture = await createScreenCaptureBridge().captureScreenshot({
      save_path: savePath,
      ...(display_index !== undefined ? { display_index } : {}),
    });
    captured = capture.save_path;
    if (!safeLstat(captured).isFile()) {
      throw new Error('current screen capture is not a regular file');
    }
    return await dhashFile(captured);
  } finally {
    safeRmSync(savePath, { force: true });
    if (captured && captured !== savePath) safeRmSync(captured, { force: true });
  }
};

function storedDisplayIndex(sessionId: string): number | undefined {
  try {
    return loadMarks(sessionId)?.display?.index;
  } catch {
    return undefined;
  }
}

export async function resolveSystemClickCoordinate(
  input: SystemMarkTargetInput,
  fallbackSessionId: string | undefined,
  deps: SystemMarkTargetDeps = {}
): Promise<{ x: number; y: number } | undefined> {
  const explicit = explicitCoordinate(input);
  if (explicit) return explicit;
  const targetMark = optionalString(input.target_mark);
  if (!targetMark) return undefined;
  const sessionId = optionalString(input.mark_session_id) ?? fallbackSessionId ?? '';
  const marksId = optionalString(input.marks_id);
  if (!sessionId) {
    throw new MarkTargetError('MARK_INVALID', `${targetMark} needs mark_session_id or session_id`);
  }

  const displayIndex = (deps.markedDisplayIndex ?? storedDisplayIndex)(sessionId);
  let currentDhash: string;
  try {
    currentDhash = await (deps.hashCurrentScreen ?? hashCurrentScreen)(
      displayIndex !== undefined ? { display_index: displayIndex } : {}
    );
  } catch (error) {
    throw new MarkTargetError(
      'MARK_STALE',
      `cannot capture the current screen to verify ${targetMark}: ${(error as Error).message}`
    );
  }

  const resolved = await (deps.resolver ?? resolveMarkTarget)(targetMark, {
    session_id: sessionId,
    current_dhash: currentDhash,
    ...(marksId ? { marks_id: marksId } : {}),
  });
  const display = resolved.display;
  if (display?.origin) {
    return { x: resolved.x + display.origin.x, y: resolved.y + display.origin.y };
  }
  if (display?.index !== undefined && display.index !== 0) {
    throw new MarkTargetError(
      'MARK_INVALID',
      `marks ${resolved.marks_id} came from display ${display.index} whose origin is unknown; pass display_origin to mark_elements`
    );
  }
  return { x: resolved.x, y: resolved.y };
}
