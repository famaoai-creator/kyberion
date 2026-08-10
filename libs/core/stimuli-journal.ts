import * as pathResolver from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeReadFile,
  safeStat,
  safeWriteFile,
} from './secure-io.js';
import { createLogger } from './logger.js';
import type { NerveMessage } from './nerve-bridge.js';

const logger = createLogger('stimuli-journal');

const STIMULI_PATH = pathResolver.resolve('presence/bridge/runtime/stimuli.jsonl');

/**
 * EV-06: the journal is append-only and was previously unbounded — readers only
 * ever looked at the last N records, so nothing ever forced it to shrink. Kept
 * at the same 5MB ceiling as the quarantine store (QM-04) for one reason to
 * remember instead of two.
 */
export const STIMULI_MAX_BYTES = 5 * 1024 * 1024;
/** After rotation, retain this share of the tail so live context survives. */
const STIMULI_RETAIN_BYTES = Math.floor(STIMULI_MAX_BYTES / 2);

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
  const record = (stimulus ?? {}) as { ttl?: unknown; metadata?: { ttl?: unknown } };
  const declared = [record.ttl, record.metadata?.ttl]
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value > 0);
  return declared ?? 0;
}

export function isStimulusExpired(stimulus: unknown, nowMs: number = Date.now()): boolean {
  const ttlSeconds = stimulusTtlSeconds(stimulus);
  if (ttlSeconds <= 0) return false;
  const ts = Date.parse(String((stimulus as { ts?: unknown })?.ts ?? ''));
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
  if (!safeExistsSync(STIMULI_PATH)) return [];
  const { enforceTtl = true, nowMs = Date.now() } = options;

  const content = safeReadFile(STIMULI_PATH, {
    encoding: 'utf8',
    maxSizeMB: Math.ceil(STIMULI_MAX_BYTES / (1024 * 1024)),
  }) as string;
  const parsed = content
    .trim()
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as NerveMessage];
      } catch {
        return [];
      }
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
  if (!safeExistsSync(STIMULI_PATH)) return false;
  let size = 0;
  try {
    size = safeStat(STIMULI_PATH).size;
  } catch {
    return false;
  }
  if (size <= maxBytes) return false;

  const content = safeReadFile(STIMULI_PATH, {
    encoding: 'utf8',
    maxSizeMB: Math.ceil((maxBytes * 2) / (1024 * 1024)) + 1,
  }) as string;
  // Cut on a record boundary so the retained head is never a partial line.
  const tail = content.slice(-STIMULI_RETAIN_BYTES);
  const firstNewline = tail.indexOf('\n');
  const retained = firstNewline >= 0 ? tail.slice(firstNewline + 1) : '';
  safeWriteFile(STIMULI_PATH, retained);
  logger.warn(
    `[stimuli-journal] rotated ${STIMULI_PATH}: ${size} bytes exceeded ${maxBytes}; retained ${Buffer.byteLength(retained, 'utf8')} bytes`
  );
  return true;
}

export function appendStimulus(stimulus: NerveMessage): void {
  safeAppendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + '\n');
  rotateStimuliJournalIfNeeded();
}

export function stimuliJournalPath(): string {
  return STIMULI_PATH;
}
