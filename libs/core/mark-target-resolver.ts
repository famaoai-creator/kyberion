import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { dhashFile, hamming } from './image-dhash.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import type { SomImageSize, SomMark } from './set-of-marks.js';

/**
 * Session-volatile store for Set-of-Marks results and the `mark:<n>` target
 * resolver used by click paths.
 *
 * A mark is only a promise about one screenshot. It is resolved against the
 * latest marks of a session and refused with [MARK_STALE] when that promise can
 * no longer be trusted: marks older than the TTL, a different marks_id than
 * the caller planned against, or a current screen whose dHash moved away from
 * the marked screenshot.
 */

export const MARKS_TTL_MS = 60_000;
/** dHash bits a current screen may differ by and still count as the marked screen. */
export const MARK_SCREEN_MAX_HAMMING = 5;
const MARKS_FILE = 'vision-marks.json';
const MARKS_VERSION = 1;
const MARK_TARGET = /^mark:(\d{1,4})$/;

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
}

export interface ResolveMarkTargetOptions {
  session_id: string;
  /** Overrides the scale stored with the marks (image px per logical point). */
  scale?: number;
  /** Refuse unless the stored marks carry this id. */
  marks_id?: string;
  /** dHash of the screen right now; refused when it moved from the marked image. */
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
  const trimmed = String(sessionId || '').trim();
  if (!trimmed) throw new MarkTargetError('MARK_INVALID', 'session_id is required');
  return trimmed;
}

export function marksStatePath(sessionId: string): string {
  return path.join(pathResolver.volatile('session', requireSessionId(sessionId)), MARKS_FILE);
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
  const record: MarksRecord = {
    version: MARKS_VERSION,
    marks_id: input.marks_id ?? randomUUID(),
    session_id: sessionId,
    created_at: now,
    expires_at: now + (input.ttl_ms ?? MARKS_TTL_MS),
    image: input.image,
    image_dhash: input.image_dhash,
    scale,
    marks: input.marks,
  };
  const statePath = marksStatePath(sessionId);
  safeMkdir(path.dirname(statePath), { recursive: true });
  safeWriteFile(statePath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
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
  const statePath = marksStatePath(sessionId);
  if (!safeExistsSync(statePath)) return undefined;
  try {
    const parsed = parseSafeJsonInput(
      String(safeReadFile(statePath, { encoding: 'utf8' })),
      'vision marks state'
    );
    return isMarksRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function clearMarks(sessionId: string): void {
  safeRmSync(marksStatePath(sessionId), { force: true });
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
  if (currentDhash) {
    const distance = hamming(currentDhash, record.image_dhash);
    if (distance > (options.max_hamming ?? MARK_SCREEN_MAX_HAMMING)) {
      throw new MarkTargetError(
        'MARK_STALE',
        `the screen changed since marks ${record.marks_id} (dHash distance ${distance}); re-run mark_elements`
      );
    }
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
  };
}
