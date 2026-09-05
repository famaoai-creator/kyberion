import { appendJsonLine, parseSafeJsonInput } from './foundation/json.js';
import { isRecord } from './foundation/text.js';
import * as pathResolver from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeReadFile,
  safeStat,
  safeWriteFile,
} from './secure-io.js';
import { createLogger } from './logger.js';
import type { NerveMessage } from './nerve-bridge.js';

const logger = createLogger('stimuli-journal');

const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');

export function resolveStimuliJournalPath(filePath: string = STIMULI_PATH): string {
  return assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
}

function safeStimuliPath(): string {
  return resolveStimuliJournalPath();
}

/**
 * EV-06: the journal is append-only and was previously unbounded — readers only
 * ever looked at the last N records, so nothing ever forced it to shrink. Kept
 * at the same 5MB ceiling as the quarantine store (QM-04) for one reason to
 * remember instead of two.
 */
export const STIMULI_MAX_BYTES = 5 * 1024 * 1024;
/** After rotation, retain this share of the tail so live context survives. */
const STIMULI_RETAIN_BYTES = Math.floor(STIMULI_MAX_BYTES / 2);

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

export function loadRecentStimuli(
  limit: number,
  options: LoadRecentStimuliOptions = {}
): NerveMessage[] {
  const stimuliPath = safeStimuliPath();
  if (!safeExistsSync(stimuliPath)) return [];
  const { enforceTtl = true, nowMs = Date.now() } = options;

  const content = safeReadFile(stimuliPath, {
    encoding: 'utf8',
    maxSizeMB: Math.ceil(STIMULI_MAX_BYTES / (1024 * 1024)),
  }) as string;
  const parsed = content
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = parseNerveMessageLine(line);
      return parsed ? [parsed] : [];
    });
  const live = enforceTtl
    ? parsed.filter((stimulus) => !isStimulusExpired(stimulus, nowMs))
    : parsed;
  // Slice after TTL filtering: taking the last N first would let expired
  // records crowd out live ones and shrink the effective context window.
  return live.slice(-limit);
}

/**
 * Trim the journal to its retention tail when it exceeds the ceiling.
 * Truncation is a rotation as far as readers are concerned; `jsonl-tail`
 * detects it via size regression and fingerprint change and restarts cleanly.
 */
export function rotateStimuliJournalIfNeeded(maxBytes: number = STIMULI_MAX_BYTES): boolean {
  const stimuliPath = safeStimuliPath();
  if (!safeExistsSync(stimuliPath)) return false;
  let size = 0;
  try {
    size = safeStat(stimuliPath).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;

  const content = safeReadFile(stimuliPath, {
    encoding: 'utf8',
    maxSizeMB: Math.ceil((maxBytes * 2) / (1024 * 1024)) + 1,
  }) as string;
  // Cut on a record boundary so the retained head is never a partial line.
  const tail = content.slice(-STIMULI_RETAIN_BYTES);
  const firstNewline = tail.indexOf('\n');
  const retained = firstNewline >= 0 ? tail.slice(firstNewline + 1) : '';
  safeWriteFile(stimuliPath, retained);
  logger.warn(
    `[stimuli-journal] rotated ${stimuliPath}: ${size} bytes exceeded ${maxBytes}; retained ${Buffer.byteLength(retained, 'utf8')} bytes`
  );
  return true;
}

export function appendStimulus(stimulus: NerveMessage): void {
  appendJsonLine(safeStimuliPath(), stimulus);
  rotateStimuliJournalIfNeeded();
}

export function stimuliJournalPath(): string {
  return safeStimuliPath();
}
