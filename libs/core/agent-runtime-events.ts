import { appendJsonLine, readJsonLines } from './foundation/json.js';
import { nowIso } from './foundation/time.js';
import { resolveSharedObservabilityDir } from './observability-gate.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeReaddir } from './secure-io.js';
import * as path from 'node:path';
import { createLogger } from './logger.js';

const logger = createLogger('agent-runtime-supervisor');
let eventWriteWarned = false;

/**
 * Resolved lazily (not cached at module scope): callers can be imported
 * well before `pathResolver`'s root is finalized (e.g. a test module that
 * initializes its temp-dir fixture in `beforeEach`, imported transitively
 * through `storage-janitor.ts`), so evaluating this eagerly at import time
 * would capture a stale or uninitialized root.
 */
function eventsDir(): string {
  return pathResolver.shared('observability/mission-control');
}

/**
 * AC-10: the pre-rotation supervisor event file. `appendSupervisorEvent` no
 * longer writes here, but production installs already have a large (multi-MB)
 * history under this name — readers keep merging it in as the oldest
 * partition. Never deleted automatically (see `storage-janitor.ts`); an
 * operator can archive/delete it by hand once it is no longer needed.
 */
export const SUPERVISOR_EVENTS_LEGACY_FILE = 'agent-runtime-supervisor-events.jsonl';

/** AC-10: `agent-runtime-supervisor-events-YYYY-MM-DD.jsonl`, one file per UTC day. */
export const SUPERVISOR_EVENTS_FILE_PATTERN =
  /^agent-runtime-supervisor-events-(\d{4}-\d{2}-\d{2})\.jsonl$/u;

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string' &&
    error.message
  ) {
    return error.message;
  }
  return String(error);
}

/** Append a best-effort, tenant-scoped runtime supervision event. */
export function appendSupervisorEvent(event: Record<string, unknown>): void {
  try {
    const obsDir = resolveSharedObservabilityDir(eventsDir());
    if (!obsDir) return;
    const safeObsDir = assertSafeRepositoryPath(obsDir, { allowMissingLeaf: true });
    safeMkdir(safeObsDir);
    const ts = nowIso();
    // AC-10: rotate daily like worker-events, instead of one file growing
    // without bound (the pre-rotation file reached 29MB / 266k lines).
    const day = ts.slice(0, 10);
    appendJsonLine(
      assertSafeRepositoryPath(
        path.join(safeObsDir, `agent-runtime-supervisor-events-${day}.jsonl`),
        { allowMissingLeaf: true }
      ),
      {
        ts,
        ...event,
      }
    );
  } catch (error: unknown) {
    // Runtime control must still succeed when a narrow authority cannot write
    // the optional observability stream.
    if (!eventWriteWarned) {
      eventWriteWarned = true;
      logger.warn(`failed to write supervisor event: ${errorMessage(error)}`);
    }
  }
}

/** Basename metadata for one on-disk supervisor event partition. */
export interface SupervisorEventFile {
  path: string;
  /** UTC `YYYY-MM-DD` for a dated file, or `null` for the legacy unrotated file. */
  date: string | null;
}

export interface ListSupervisorEventFilesOptions {
  /** Only include dated files within this many days of `now` (inclusive). Unset = all dated files. */
  recentDays?: number;
  /** ISO instant the recency window is relative to. Defaults to `nowIso()`. */
  now?: string;
  /** Include the legacy unrotated file. Default `true` — it is history, not noise. */
  includeLegacy?: boolean;
  /** Test override for the directory to list. Re-validated through `assertSafeRepositoryPath`. */
  dir?: string;
}

function resolveEventsDir(dirOverride: string | undefined): string | null {
  try {
    return assertSafeRepositoryPath(dirOverride ?? eventsDir(), { allowMissingLeaf: true });
  } catch {
    return null;
  }
}

function safeOptionalPath(filePath: string): string | null {
  try {
    return assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  } catch {
    return null;
  }
}

/** Is a dated file's UTC day within `recentDays` of `now` (inclusive)? Mirrors the
 * worker-event-file window in `agent-collaboration-projection.ts`. */
function isWithinRecentDays(dateStr: string, nowIsoValue: string, recentDays: number): boolean {
  const fileDayMs = Date.parse(`${dateStr}T00:00:00.000Z`);
  const nowMs = Date.parse(nowIsoValue);
  if (!Number.isFinite(fileDayMs) || !Number.isFinite(nowMs)) return true;
  const nowDayMs = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const diffDays = Math.round((nowDayMs - fileDayMs) / 86_400_000);
  return diffDays >= 0 && diffDays <= recentDays;
}

/**
 * AC-10: list on-disk supervisor event partitions, oldest first (legacy file
 * first, since it predates every dated file), for `readSupervisorEvents` and
 * `storage-janitor.ts`'s retention sweep.
 */
export function listSupervisorEventFiles(
  options: ListSupervisorEventFilesOptions = {}
): SupervisorEventFile[] {
  const dir = resolveEventsDir(options.dir);
  if (!dir || !safeExistsSync(dir)) return [];
  const includeLegacy = options.includeLegacy !== false;
  const nowIsoValue = options.now ?? nowIso();

  let entries: string[];
  try {
    entries = safeReaddir(dir);
  } catch {
    return [];
  }

  let legacyFile: SupervisorEventFile | null = null;
  const dated: SupervisorEventFile[] = [];
  for (const entry of entries) {
    if (entry === SUPERVISOR_EVENTS_LEGACY_FILE) {
      const filePath = safeOptionalPath(path.join(dir, entry));
      if (filePath) legacyFile = { path: filePath, date: null };
      continue;
    }
    const match = SUPERVISOR_EVENTS_FILE_PATTERN.exec(entry);
    if (!match) continue;
    if (
      options.recentDays !== undefined &&
      !isWithinRecentDays(match[1], nowIsoValue, options.recentDays)
    ) {
      continue;
    }
    const filePath = safeOptionalPath(path.join(dir, entry));
    if (filePath) dated.push({ path: filePath, date: match[1] });
  }
  dated.sort((a, b) => (a.date! < b.date! ? -1 : a.date! > b.date! ? 1 : 0));

  const files: SupervisorEventFile[] = [];
  if (includeLegacy && legacyFile) files.push(legacyFile);
  files.push(...dated);
  return files;
}

/**
 * AC-10: read every supervisor event partition (legacy + dated), oldest
 * first, skipping malformed lines. Replaces direct reads of the single
 * `agent-runtime-supervisor-events.jsonl` file in `report-ops.ts` and
 * `mission-retrospective.ts` now that the writer rotates daily.
 */
export function readSupervisorEvents(
  options: ListSupervisorEventFilesOptions = {}
): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const file of listSupervisorEventFiles(options)) {
    if (!safeExistsSync(file.path)) continue;
    const lines = readJsonLines<Record<string, unknown> | null>(file.path, {
      onMalformed: 'skip',
      map: (value) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null,
    });
    for (const line of lines) {
      if (line) records.push(line);
    }
  }
  return records;
}
