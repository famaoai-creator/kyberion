import { pathResolver } from './path-resolver.js';
import { safeReadFile, safeWriteFile, safeExistsSync } from './secure-io.js';
import * as nodePath from 'node:path';
import { createLogger } from './logger.js';
const logger = createLogger('unhandled-intent-registry');

export type IntentMissType = 'unrouted' | 'unrecognized';

export interface UnhandledIntentEntry {
  /** 'unrouted': intent ID resolved but not in routing map. 'unrecognized': utterance below confidence threshold. */
  miss_type: IntentMissType;
  /** Set for 'unrouted'. For 'unrecognized', the best candidate ID if one was scored (may be undefined). */
  intent_id?: string;
  /** execution_shape from the intent definition, if known. */
  shape?: string;
  /** Up to 3 unique utterance excerpts (100 chars each) for context. */
  utterance_samples: string[];
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  reconciled: boolean;
  reconciled_at?: string;
}

interface UnhandledIntentRegistry {
  version: '1.0.0';
  entries: UnhandledIntentEntry[];
}

const REGISTRY_RELATIVE = nodePath.join(
  'active',
  'shared',
  'tmp',
  'unhandled-intent-registry.json'
);
const UTTERANCE_EXCERPT_LEN = 100;
const MAX_UTTERANCE_SAMPLES = 3;

// 60 s in-process cooldown per dedup key to avoid disk churn on bursty traffic.
const _recentWrites = new Map<string, number>();
const COOLDOWN_MS = 60_000;

function registryPath(): string {
  return nodePath.join(pathResolver.rootDir(), REGISTRY_RELATIVE);
}

function readRegistry(): UnhandledIntentRegistry {
  try {
    const p = registryPath();
    if (!safeExistsSync(p)) return { version: '1.0.0', entries: [] };
    return JSON.parse(safeReadFile(p, { encoding: 'utf8' }) as string) as UnhandledIntentRegistry;
  } catch {
    return { version: '1.0.0', entries: [] };
  }
}

function writeRegistry(registry: UnhandledIntentRegistry): void {
  try {
    safeWriteFile(registryPath(), JSON.stringify(registry, null, 2));
  } catch {
    /* observability must never break the caller */
  }
}

function dedupeKey(
  missType: IntentMissType,
  intentId: string | undefined,
  utteranceExcerpt: string
): string {
  if (missType === 'unrouted' && intentId) return `unrouted:${intentId}`;
  return `unrecognized:${utteranceExcerpt.slice(0, 60)}`;
}

/**
 * Record an intent that could not be handled.
 *
 * - 'unrouted': a known intent ID was resolved but no pipeline / mission action entry exists.
 * - 'unrecognized': the utterance scored below the confidence threshold for all known intents.
 *
 * Never throws. 60 s in-process cooldown per unique (missType, intentId/utterance) key.
 */
export function recordUnhandledIntent(opts: {
  missType: IntentMissType;
  intentId?: string;
  shape?: string;
  utterance: string;
}): void {
  try {
    const utteranceExcerpt = opts.utterance.slice(0, UTTERANCE_EXCERPT_LEN);
    const key = dedupeKey(opts.missType, opts.intentId, utteranceExcerpt);
    const now = Date.now();

    const lastWrite = _recentWrites.get(key);
    if (lastWrite !== undefined && now - lastWrite < COOLDOWN_MS) return;
    _recentWrites.set(key, now);

    const timestamp = new Date(now).toISOString();
    const registry = readRegistry();

    const matchExisting = (e: UnhandledIntentEntry): boolean => {
      if (e.miss_type !== opts.missType) return false;
      if (opts.missType === 'unrouted') return e.intent_id === opts.intentId;
      return e.utterance_samples.some((s) => s.startsWith(utteranceExcerpt.slice(0, 40)));
    };

    const existing = registry.entries.find(matchExisting);

    if (existing) {
      existing.occurrence_count += 1;
      existing.last_seen = timestamp;
      if (
        !existing.utterance_samples.includes(utteranceExcerpt) &&
        existing.utterance_samples.length < MAX_UTTERANCE_SAMPLES
      ) {
        existing.utterance_samples.push(utteranceExcerpt);
      }
    } else {
      registry.entries.push({
        miss_type: opts.missType,
        ...(opts.intentId !== undefined ? { intent_id: opts.intentId } : {}),
        ...(opts.shape !== undefined ? { shape: opts.shape } : {}),
        utterance_samples: [utteranceExcerpt],
        first_seen: timestamp,
        last_seen: timestamp,
        occurrence_count: 1,
        reconciled: false,
      });
    }

    writeRegistry(registry);
  } catch {
    /* never propagate */
  }
}

export function listUnhandledIntents(): UnhandledIntentEntry[] {
  return readRegistry().entries;
}

export function markIntentsReconciled(keys: string[]): void {
  try {
    const set = new Set(keys);
    const registry = readRegistry();
    const now = new Date().toISOString();
    for (const entry of registry.entries) {
      const k = entry.intent_id ?? entry.utterance_samples[0] ?? '';
      if (set.has(k)) {
        entry.reconciled = true;
        entry.reconciled_at = now;
      }
    }
    writeRegistry(registry);
  } catch (err) {
    logger.warn(`suppressed error in markIntentsReconciled: ${err}`);
  }
}

export function pruneReconciledIntents(): number {
  try {
    const registry = readRegistry();
    const before = registry.entries.length;
    registry.entries = registry.entries.filter((e) => !e.reconciled);
    writeRegistry(registry);
    return before - registry.entries.length;
  } catch {
    return 0;
  }
}
