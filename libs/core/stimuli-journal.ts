import * as path from 'node:path';
import { withExecutionContext } from './authority.js';
import { appendJsonLine, parseSafeJsonInput } from './foundation/json.js';
import { isRecord } from './foundation/text.js';
import * as pathResolver from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReaddir } from './secure-io.js';
import { readJsonLinesBackward } from './jsonl-read.js';
import { maintainStoreAfterAppend, rotatedSegmentStem } from './append-only-store.js';
import type { NerveMessage } from './nerve-bridge.js';
import type { SlackSurfaceArtifact } from './surface/channel-surface-types.js';
import type { SensorStimulus } from './sensor-engine.js';

const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');

/**
 * SB-01: the journal's own store-writer role. Its writes (append + rotation)
 * used to run under whatever role was current, so a caller inside another
 * in-process assumption (e.g. mission_controller under SYSTEM_ROLE=slack_bridge,
 * including async continuations of that scope) was denied — and nerve-bridge
 * swallows the error. infrastructure_sentinel is a shared core role (allowed
 * under every SYSTEM_ROLE, role-assumption-policy.json) that already owns the
 * nerve/mesh bus stores and is granted presence/bridge/runtime/.
 *
 * Because every caller now writes as the same role, a journal record says
 * nothing about who produced it: `from` / `node_id` / `intent` are
 * self-declared. The journal must therefore never become an authorization
 * input — e.g. dynamic-permission-guard's contextual grants (keyed on a
 * recent stimulus intent/keyword via sensory-memory) must stay unwired from
 * tier-guard / secure-io / policy-engine until the writer is authenticated
 * (signed or attributed records). stimuli-journal-rotation-role.test.ts
 * pins that no authorization module imports it.
 */
export const STIMULI_JOURNAL_WRITER_ROLE = 'infrastructure_sentinel';

export function resolveStimuliJournalPath(filePath: string = STIMULI_PATH): string {
  return assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
}

function safeStimuliPath(): string {
  return resolveStimuliJournalPath();
}

export function isRegularStimuliJournalPath(filePath: string = STIMULI_PATH): boolean {
  try {
    const safePath = resolveStimuliJournalPath(filePath);
    return safeExistsSync(safePath) && safeLstat(safePath).isFile();
  } catch {
    return false;
  }
}

/**
 * EV-06: the journal is append-only and was previously unbounded — readers only
 * ever looked at the last N records, so nothing ever forced it to shrink.
 * Write-time rotation threshold (the same 5MB as the quarantine store, QM-04):
 * past it, the shared append-only-store rotation renames the journal to a
 * `stimuli-YYYYMMDD-HHmmss.jsonl` segment (expired by the janitor's 7-day
 * presence/bridge/runtime sweep). It is not a cap — reads scan backwards and
 * never fail on size, and an append never throws because of size
 * (MSN-STORE-BOUNDS-20261101).
 */
export const STIMULI_MAX_BYTES = 5 * 1024 * 1024;

const ROTATED_SEGMENT_SUFFIX = /^(\d{8}-\d{6})(?:-(\d+))?\.jsonl$/u;

function isRegularFile(filePath: string): boolean {
  try {
    return safeExistsSync(filePath) && safeLstat(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Rotated segments of the journal, newest first. Readers continue into them so
 * the context a rotation moved aside is not lost to the next hydration.
 */
function rotatedStimuliSegments(stimuliPath: string): string[] {
  const dir = path.dirname(stimuliPath);
  const prefix = `${rotatedSegmentStem(stimuliPath)}-`;
  let names: string[];
  try {
    names = safeReaddir(dir);
  } catch {
    return [];
  }
  const segments: Array<{ name: string; stamp: string; n: number }> = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const match = name.slice(prefix.length).match(ROTATED_SEGMENT_SUFFIX);
    if (match) segments.push({ name, stamp: match[1]!, n: Number(match[2] ?? 0) });
  }
  return segments
    .sort((a, b) => (a.stamp === b.stamp ? b.n - a.n : a.stamp < b.stamp ? 1 : -1))
    .map((entry) => path.join(dir, entry.name))
    .filter(isRegularFile);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`stimulus.${key} must be a non-empty string`);
  }
  return value;
}

/** Normalize the NerveMessage subset of the mixed stimuli journal. */
export function normalizeNerveMessage(value: unknown): NerveMessage {
  if (!isRecord(value)) throw new Error('stimulus must be a JSON object');

  const type = value.type;
  if (type !== 'request' && type !== 'response' && type !== 'event') {
    throw new Error('stimulus.type must be request, response, or event');
  }
  const to = requiredString(value, 'to');
  const metadataValue = value.metadata;
  let metadata: NerveMessage['metadata'];
  if (metadataValue !== undefined) {
    if (!isRecord(metadataValue)) throw new Error('stimulus.metadata must be a JSON object');
    const replyTo = metadataValue.reply_to;
    const missionId = metadataValue.mission_id;
    const ttl = metadataValue.ttl;
    if (replyTo !== undefined && typeof replyTo !== 'string') {
      throw new Error('stimulus.metadata.reply_to must be a string');
    }
    if (missionId !== undefined && typeof missionId !== 'string') {
      throw new Error('stimulus.metadata.mission_id must be a string');
    }
    if (ttl !== undefined && (typeof ttl !== 'number' || !Number.isFinite(ttl))) {
      throw new Error('stimulus.metadata.ttl must be finite');
    }
    metadata = {};
    if (typeof replyTo === 'string') metadata.reply_to = replyTo;
    if (typeof missionId === 'string') metadata.mission_id = missionId;
    if (typeof ttl === 'number') metadata.ttl = ttl;
  }

  return {
    id: requiredString(value, 'id'),
    ts: requiredString(value, 'ts'),
    from: requiredString(value, 'from'),
    node_id: requiredString(value, 'node_id'),
    to,
    type,
    intent: requiredString(value, 'intent'),
    payload: value.payload,
    ...(metadata ? { metadata } : {}),
  };
}

export function parseNerveMessageLine(line: string): NerveMessage | undefined {
  try {
    return normalizeNerveMessage(parseSafeJsonInput(line, 'stimulus journal entry'));
  } catch {
    return undefined;
  }
}

/**
 * EV-04: TTL is declared on stimuli in two shapes on the same file — the
 * `NerveMessage.metadata.ttl` written by nerve-bridge and the top-level `ttl`
 * written by the surface ingress path. Read both, so enforcement does not
 * depend on which producer wrote the record.
 *
 * A missing or non-positive TTL means "no expiry", matching the check
 * nexus-daemon already applies (`stimulus.ttl > 0 && age > stimulus.ttl`).
 * Callers that need a bounded window pass one explicitly instead.
 */
export function stimulusTtlSeconds(stimulus: unknown): number {
  const record = isRecord(stimulus) ? stimulus : {};
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const declared = [record.ttl, metadata.ttl]
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value > 0);
  return declared ?? 0;
}

export function isStimulusExpired(stimulus: unknown, nowMs: number = Date.now()): boolean {
  const ttlSeconds = stimulusTtlSeconds(stimulus);
  if (ttlSeconds <= 0) return false;
  const ts = Date.parse(isRecord(stimulus) && typeof stimulus.ts === 'string' ? stimulus.ts : '');
  if (!Number.isFinite(ts)) return false;
  return (nowMs - ts) / 1000 > ttlSeconds;
}

export interface LoadRecentStimuliOptions {
  /** Drop records past their declared TTL. Default true. */
  enforceTtl?: boolean;
  nowMs?: number;
}

/** Test seams: simulate a rotation at the racy points of {@link loadRecentStimuli}. */
export interface StimuliJournalReadHooks {
  /** After the live journal was found, before its scan opens it. */
  beforeLiveScan?: () => void;
  /** After the first record of the live scan. */
  afterFirstLiveRecord?: () => void;
}
let readHooks: StimuliJournalReadHooks = {};

/** Test seam: install read hooks; call with `{}` to reset. */
export function setStimuliJournalReadHooksForTests(hooks: StimuliJournalReadHooks): void {
  readHooks = { ...hooks };
}

/**
 * The newest `limit` live stimuli, oldest first. Scans the journal backwards
 * (then its rotated segments, newest first) and stops once `limit` records
 * survive the TTL filter, so the cost follows `limit`, not the journal size.
 *
 * Safe against a concurrent rotation: the live scan holds the inode it opened,
 * the segment list is taken after it (so a journal rotated before the scan
 * opened it is read as a segment, not lost), and a record id already read is
 * skipped (so a journal rotated during the scan is not read twice).
 */
export function loadRecentStimuli(
  limit: number,
  options: LoadRecentStimuliOptions = {}
): NerveMessage[] {
  if (!(limit > 0)) return [];
  const stimuliPath = safeStimuliPath();
  const { enforceTtl = true, nowMs = Date.now() } = options;
  const newestFirst: NerveMessage[] = [];
  const seenIds = new Set<string>();
  /** Scans one source; true once `limit` records were collected. */
  const take = (source: string, live: boolean): boolean => {
    let first = live;
    for (const stimulus of readJsonLinesBackward<NerveMessage>(source, {
      onMalformed: 'skip',
      map: normalizeNerveMessage,
    })) {
      if (first) {
        first = false;
        readHooks.afterFirstLiveRecord?.();
      }
      if (seenIds.has(stimulus.id)) continue;
      seenIds.add(stimulus.id);
      // Filter before counting: expired records must not crowd out live ones
      // and shrink the effective context window.
      if (enforceTtl && isStimulusExpired(stimulus, nowMs)) continue;
      newestFirst.push(stimulus);
      if (newestFirst.length >= limit) return true;
    }
    return false;
  };
  if (isRegularStimuliJournalPath(stimuliPath)) {
    readHooks.beforeLiveScan?.();
    if (take(stimuliPath, true)) return newestFirst.reverse();
  }
  for (const segment of rotatedStimuliSegments(stimuliPath)) {
    if (take(segment, false)) break;
  }
  return newestFirst.reverse();
}

/**
 * Rotate the journal through the shared append-only-store rotation once it
 * exceeds `maxBytes`. Rotation is a rename to a segment; `jsonl-tail` detects
 * it via size regression and fingerprint change and restarts cleanly, and
 * {@link loadRecentStimuli} reads on into the segment. Never throws (a failure
 * warns); returns whether it rotated.
 */
export function rotateStimuliJournalIfNeeded(maxBytes: number = STIMULI_MAX_BYTES): boolean {
  return withExecutionContext(STIMULI_JOURNAL_WRITER_ROLE, () => rotateStimuliJournal(maxBytes));
}

function rotateStimuliJournal(maxBytes: number): boolean {
  const stimuliPath = safeStimuliPath();
  if (!isRegularStimuliJournalPath(stimuliPath)) return false;
  return (
    maintainStoreAfterAppend(stimuliPath, { action: 'rotate', minBytes: maxBytes + 1 }) ===
    'rotated'
  );
}

/**
 * A record of the mixed journal: a nerve message, or a GUSP stimulus from a
 * channel surface (the Slack bridge) or a sensor. Records are written as-is.
 */
export type StimuliJournalRecord = NerveMessage | SlackSurfaceArtifact['stimulus'] | SensorStimulus;

export function appendStimulus(stimulus: StimuliJournalRecord): void {
  withExecutionContext(STIMULI_JOURNAL_WRITER_ROLE, () => {
    appendJsonLine(safeStimuliPath(), stimulus);
    // Write-time retention; it never throws, so size cannot fail the append.
    rotateStimuliJournal(STIMULI_MAX_BYTES);
  });
}

export function stimuliJournalPath(): string {
  return safeStimuliPath();
}
