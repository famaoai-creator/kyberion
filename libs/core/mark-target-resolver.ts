import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { dhashFile, hamming } from './image-dhash.js';
import { assertVolatileId, findMissionPath, pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { safeMarkLabel, type SomImageSize, type SomMark } from './set-of-marks.js';

/**
 * Session-volatile store for Set-of-Marks results and the `mark:<n>` target
 * resolver used by click paths.
 *
 * A mark is only a promise about one screenshot. It is resolved against the
 * latest marks of a session and refused with [MARK_STALE] when that promise can
 * no longer be trusted: marks older than the TTL, a different marks_id than
 * the caller planned against, or a current screen whose dHash moved away from
 * the marked screenshot. The current screen hash is mandatory: a resolver that
 * cannot see the screen refuses rather than trusting the TTL alone.
 *
 * Non-public marks live in the mission directory; the session dir then holds
 * only a pointer (mission id + marks id), never labels or boxes.
 */

export const MARKS_TTL_MS = 60_000;
/** dHash bits a current screen may differ by and still count as the marked screen. */
export const MARK_SCREEN_MAX_HAMMING = 5;
const MARKS_FILE = 'vision-marks.json';
const MARKS_VERSION = 1;
const POINTER_KIND = 'vision-marks-pointer';
const MARK_TARGET = /^mark:(\d{1,4})$/;

export type MarksTier = 'public' | 'confidential' | 'personal';

/** Display the marked screenshot was taken on. */
export interface MarksDisplay {
  index?: number;
  /** Top-left of the display in global logical points, when known. */
  origin?: { x: number; y: number };
}

export interface MarksRecord {
  version: number;
  marks_id: string;
  session_id: string;
  created_at: number;
  expires_at: number;
  image: SomImageSize;
  image_dhash: string;
  /** Image pixels per logical point (e.g. 2 on a Retina capture). */
  scale: number;
  marks: SomMark[];
  tier?: MarksTier;
  mission_id?: string;
  /** Browser snapshot the DOM refs of these marks belong to. */
  dom_snapshot_id?: string;
  display?: MarksDisplay;
}

export interface SaveMarksInput {
  session_id: string;
  marks: SomMark[];
  image: SomImageSize;
  image_dhash: string;
  scale?: number;
  ttl_ms?: number;
  now?: () => number;
  marks_id?: string;
  /** Defaults to public. Non-public marks require mission_id. */
  tier?: MarksTier;
  /** Existing mission whose directory holds the marks. */
  mission_id?: string;
  dom_snapshot_id?: string;
  display?: MarksDisplay;
}

interface MarksPointer {
  version: number;
  kind: typeof POINTER_KIND;
  session_id: string;
  marks_id: string;
  mission_id: string;
}

export interface ResolveMarkTargetOptions {
  session_id: string;
  /** Overrides the scale stored with the marks (image px per logical point). */
  scale?: number;
  /** Refuse unless the stored marks carry this id. */
  marks_id?: string;
  /**
   * dHash of the screen right now; refused when it moved from the marked
   * image. One of current_dhash / current_image_path is required.
   */
  current_dhash?: string;
  /** Screenshot of the screen right now; hashed when current_dhash is absent. */
  current_image_path?: string;
  max_hamming?: number;
  now?: () => number;
}

export interface MarkTargetResolution {
  n: number;
  marks_id: string;
  /** Mark center in logical points (image pixels / scale). */
  x: number;
  y: number;
  /** Browser snapshot ref when the mark came from the DOM. */
  ref?: string;
  label?: string;
  dom_snapshot_id?: string;
  display?: MarksDisplay;
}

export type MarkTargetErrorCode = 'MARK_STALE' | 'MARK_INVALID';

export class MarkTargetError extends Error {
  readonly code: MarkTargetErrorCode;

  constructor(code: MarkTargetErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'MarkTargetError';
    this.code = code;
  }
}

function requireSessionId(sessionId: string): string {
  if (!String(sessionId || '').trim()) {
    throw new MarkTargetError('MARK_INVALID', 'session_id is required');
  }
  try {
    return assertVolatileId('session', sessionId);
  } catch (error) {
    throw new MarkTargetError('MARK_INVALID', (error as Error).message);
  }
}

/** Session-dir file: the marks themselves (public) or a pointer to them. */
export function marksStatePath(sessionId: string): string {
  return path.join(pathResolver.volatile('session', requireSessionId(sessionId)), MARKS_FILE);
}

/** Mission-local marks file; the mission must already exist. */
export function missionMarksStatePath(missionId: string, sessionId: string): string {
  let missionPath: string | null;
  try {
    missionPath = findMissionPath(assertVolatileId('mission', missionId));
  } catch (error) {
    throw new MarkTargetError('MARK_INVALID', (error as Error).message);
  }
  if (!missionPath) {
    throw new MarkTargetError('MARK_INVALID', `mission '${missionId}' does not exist`);
  }
  return path.join(missionPath, 'tmp', 'vision-marks', requireSessionId(sessionId), MARKS_FILE);
}

/** The mark number of a `mark:<n>` target, or undefined for any other string. */
export function parseMarkTarget(target: unknown): number | undefined {
  if (typeof target !== 'string') return undefined;
  const match = MARK_TARGET.exec(target.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  return n >= 1 ? n : undefined;
}

export function isMarkTarget(target: unknown): boolean {
  return parseMarkTarget(target) !== undefined;
}

export function saveMarks(input: SaveMarksInput): MarksRecord {
  const sessionId = requireSessionId(input.session_id);
  const now = (input.now ?? Date.now)();
  const scale = input.scale ?? 1;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new MarkTargetError('MARK_INVALID', 'scale must be a positive number');
  }
  const tier = input.tier ?? 'public';
  const missionId = input.mission_id?.trim() || undefined;
  if (tier !== 'public' && !missionId) {
    throw new MarkTargetError('MARK_INVALID', `${tier} marks need a mission_id to stay in scope`);
  }
  const record: MarksRecord = {
    version: MARKS_VERSION,
    marks_id: input.marks_id ?? randomUUID(),
    session_id: sessionId,
    created_at: now,
    expires_at: now + (input.ttl_ms ?? MARKS_TTL_MS),
    image: input.image,
    image_dhash: input.image_dhash,
    scale,
    marks: input.marks.map(({ label, ...mark }) => {
      const safe = safeMarkLabel(label);
      return safe ? { ...mark, label: safe } : mark;
    }),
    tier,
    ...(missionId ? { mission_id: missionId } : {}),
    ...(input.dom_snapshot_id ? { dom_snapshot_id: input.dom_snapshot_id } : {}),
    ...(input.display ? { display: input.display } : {}),
  };
  const statePath = marksStatePath(sessionId);
  if (missionId) {
    const scopedPath = missionMarksStatePath(missionId, sessionId);
    writeJson(scopedPath, record);
    const pointer: MarksPointer = {
      version: MARKS_VERSION,
      kind: POINTER_KIND,
      session_id: sessionId,
      marks_id: record.marks_id,
      mission_id: missionId,
    };
    writeJson(statePath, pointer);
  } else {
    writeJson(statePath, record);
  }
  return record;
}

function writeJson(filePath: string, value: unknown): void {
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath: string, label: string): unknown {
  if (!safeExistsSync(filePath)) return undefined;
  try {
    return parseSafeJsonInput(String(safeReadFile(filePath, { encoding: 'utf8' })), label);
  } catch {
    return undefined;
  }
}

function isMarksPointer(value: unknown): value is MarksPointer {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MarksPointer>;
  return (
    candidate.version === MARKS_VERSION &&
    candidate.kind === POINTER_KIND &&
    typeof candidate.marks_id === 'string' &&
    typeof candidate.mission_id === 'string'
  );
}

function isMarksRecord(value: unknown): value is MarksRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<MarksRecord>;
  return (
    candidate.version === MARKS_VERSION &&
    typeof candidate.marks_id === 'string' &&
    typeof candidate.expires_at === 'number' &&
    typeof candidate.image_dhash === 'string' &&
    typeof candidate.scale === 'number' &&
    Array.isArray(candidate.marks)
  );
}

export function loadMarks(sessionId: string): MarksRecord | undefined {
  const id = requireSessionId(sessionId);
  const parsed = readJson(marksStatePath(id), 'vision marks state');
  if (isMarksPointer(parsed)) {
    if (parsed.session_id !== id) return undefined;
    const scoped = readJson(missionMarksStatePath(parsed.mission_id, id), 'vision marks state');
    return isMarksRecord(scoped) && scoped.marks_id === parsed.marks_id && scoped.session_id === id
      ? scoped
      : undefined;
  }
  // A full record in the session dir is only trusted when it is public.
  return isMarksRecord(parsed) && (parsed.tier ?? 'public') === 'public' ? parsed : undefined;
}

export function clearMarks(sessionId: string): void {
  const statePath = marksStatePath(sessionId);
  const parsed = readJson(statePath, 'vision marks state');
  if (isMarksPointer(parsed)) {
    try {
      safeRmSync(missionMarksStatePath(parsed.mission_id, sessionId), { force: true });
    } catch {
      // A vanished mission leaves nothing to clear.
    }
  }
  safeRmSync(statePath, { force: true });
}

export async function resolveMarkTarget(
  target: string,
  options: ResolveMarkTargetOptions
): Promise<MarkTargetResolution> {
  const n = parseMarkTarget(target);
  if (n === undefined) {
    throw new MarkTargetError('MARK_INVALID', `target must look like mark:<n>, got '${target}'`);
  }
  const sessionId = requireSessionId(options.session_id);
  const record = loadMarks(sessionId);
  if (!record) {
    throw new MarkTargetError(
      'MARK_STALE',
      `no marks for session '${sessionId}'; run vision mark_elements first`
    );
  }
  const now = (options.now ?? Date.now)();
  if (now >= record.expires_at) {
    throw new MarkTargetError(
      'MARK_STALE',
      `marks ${record.marks_id} expired ${now - record.expires_at}ms ago; re-run mark_elements`
    );
  }
  if (options.marks_id && options.marks_id !== record.marks_id) {
    throw new MarkTargetError(
      'MARK_STALE',
      `marks ${options.marks_id} were superseded by ${record.marks_id}; re-read the marks`
    );
  }
  const currentDhash =
    options.current_dhash ??
    (options.current_image_path ? await dhashFile(options.current_image_path) : undefined);
  if (!currentDhash) {
    throw new MarkTargetError(
      'MARK_STALE',
      `cannot verify the current screen against marks ${record.marks_id}; a current screen hash is required`
    );
  }
  let distance: number;
  try {
    distance = hamming(currentDhash, record.image_dhash);
  } catch {
    throw new MarkTargetError('MARK_STALE', 'the current screen hash is malformed');
  }
  if (distance > (options.max_hamming ?? MARK_SCREEN_MAX_HAMMING)) {
    throw new MarkTargetError(
      'MARK_STALE',
      `the screen changed since marks ${record.marks_id} (dHash distance ${distance}); re-run mark_elements`
    );
  }
  const mark = record.marks.find((entry) => entry.n === n);
  if (!mark) {
    throw new MarkTargetError(
      'MARK_STALE',
      `mark ${n} is not in marks ${record.marks_id} (${record.marks.length} marks)`
    );
  }
  const scale = options.scale ?? record.scale;
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new MarkTargetError('MARK_INVALID', 'scale must be a positive number');
  }
  return {
    n,
    marks_id: record.marks_id,
    x: Math.round(mark.center.x / scale),
    y: Math.round(mark.center.y / scale),
    ...(mark.ref ? { ref: mark.ref } : {}),
    ...(mark.label ? { label: mark.label } : {}),
    ...(record.dom_snapshot_id ? { dom_snapshot_id: record.dom_snapshot_id } : {}),
    ...(record.display ? { display: record.display } : {}),
  };
}
