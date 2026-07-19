import path from 'node:path';
import { logger } from './core.js';
import { matchesAllowedOrigin } from './origin-policy.js';
import { pathResolver } from './path-resolver.js';
import { delegateStructured, getReasoningBackend } from './reasoning-backend.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import {
  PROCEDURE_RESOLUTION_THRESHOLDS,
  type ProcedureCatalog,
  type ProcedureEntry,
  type ProcedureResolution,
} from './procedure-types.js';

const PROCEDURES_PATH = 'knowledge/product/orchestration/procedures.json';
/** User-local overlay. This path is intentionally ignored by git. */
const PERSONAL_PROCEDURES_PATH = pathResolver.knowledge('personal/browser-procedures.json');

/**
 * Allowlisted store for recordings backing procedures. A catalog entry's
 * `adapter.recording_ref` MUST resolve inside this directory — this is the
 * trust boundary that stops a poisoned catalog from pointing the dispatcher at
 * an arbitrary file in the repo.
 */
const RECORDINGS_STORE = pathResolver.shared('runtime/recordings');
const PERSONAL_RECORDINGS_STORE = pathResolver.knowledge('personal/browser-recordings');

let catalogCache: ProcedureEntry[] | null = null;

/** Minimum structural shape an entry must have to be dispatchable. */
function isStructurallyValid(entry: unknown): entry is ProcedureEntry {
  if (!entry || typeof entry !== 'object') return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.procedure_id === 'string' &&
    e.procedure_id.length > 0 &&
    typeof e.substrate === 'string' &&
    e.adapter != null &&
    typeof e.adapter === 'object' &&
    Array.isArray(e.intent_phrases) &&
    e.intent_phrases.length > 0 &&
    typeof e.status === 'string'
  );
}

/**
 * Load all procedures from the on-disk catalog. Malformed entries are dropped
 * with a warning and duplicate procedure_ids are rejected (first wins) so a
 * corrupt or hand-edited catalog cannot silently shadow a legitimate entry.
 */
export function loadProcedures(forceRefresh = false): ProcedureEntry[] {
  if (!forceRefresh && catalogCache !== null) return catalogCache;
  const sources = [
    // Personal procedures win on an ID collision: the public catalog remains
    // unchanged while a user can intentionally override a product example.
    { label: 'personal browser-procedures.json', file: PERSONAL_PROCEDURES_PATH, optional: true },
    { label: 'procedures.json', file: pathResolver.rootResolve(PROCEDURES_PATH), optional: false },
  ];
  const seen = new Set<string>();
  const valid: ProcedureEntry[] = [];
  let loadedAny = false;
  for (const source of sources) {
    if (source.optional && !safeExistsSync(source.file)) continue;
    try {
      const raw = safeReadFile(source.file, { encoding: 'utf8' }) as string;
      const parsed = JSON.parse(raw) as ProcedureCatalog;
      const entries = Array.isArray(parsed.procedures) ? parsed.procedures : [];
      loadedAny = true;
      for (const entry of entries) {
        if (!isStructurallyValid(entry)) {
          logger.warn(
            `[procedure-registry] dropping structurally-invalid entry from ${source.label}`
          );
          continue;
        }
        if (seen.has(entry.procedure_id)) {
          logger.warn(
            `[procedure-registry] duplicate procedure_id "${entry.procedure_id}" — keeping first`
          );
          continue;
        }
        seen.add(entry.procedure_id);
        valid.push(entry);
      }
    } catch {
      if (!source.optional) {
        logger.info('[procedure-registry] procedures.json unavailable — returning empty catalog');
      }
    }
  }
  catalogCache = loadedAny ? valid : [];
  return catalogCache;
}

/** Invalidate the in-process cache after a catalog write. */
export function invalidateProcedureCache(): void {
  catalogCache = null;
}

/**
 * Resolve and validate a catalog `recording_ref` against the allowlisted store.
 * Returns the absolute path iff the ref resolves *inside* RECORDINGS_STORE with
 * no traversal escape; returns null otherwise. Callers MUST treat null as
 * "refuse to dispatch".
 */
export function resolveAllowlistedRecordingRef(recordingRef: string | undefined): string | null {
  if (!recordingRef || typeof recordingRef !== 'string') return null;
  const abs = path.resolve(pathResolver.rootResolve(recordingRef));
  const stores = [RECORDINGS_STORE, PERSONAL_RECORDINGS_STORE].map((store) => path.resolve(store));
  // Must be strictly within a store (defends against ../ escape and prefix tricks).
  return stores.some((store) => abs !== store && abs.startsWith(store + path.sep)) ? abs : null;
}

// ---------------------------------------------------------------------------
// Stage-1 deterministic scoring (no I/O, works with stub backend)
// ---------------------------------------------------------------------------

/** Lowercase + collapse CJK/ASCII whitespace/punctuation into single spaces. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s　、。・，！？「」【】（）()『』]+/g, ' ')
    .trim();
}

/**
 * Score how well `phrase` matches `intent`.
 * Returns 0..0.9; full containment ≥ 0.85, token overlap < 0.75.
 */
function phraseScore(phrase: string, intent: string): number {
  const normPhrase = normalize(phrase);
  const normIntent = normalize(intent);
  if (!normPhrase || !normIntent) return 0;

  // Direct substring containment (handles Japanese phrases well)
  if (normIntent.includes(normPhrase)) return 0.9;
  if (normPhrase.includes(normIntent)) return 0.85;

  // Space-separated token overlap (useful for EN / mixed intent strings)
  const phraseWords = normPhrase.split(/\s+/).filter(Boolean);
  if (phraseWords.length === 0) return 0;
  const matchCount = phraseWords.filter((w) => normIntent.includes(w)).length;
  return matchCount > 0 ? (matchCount / phraseWords.length) * 0.7 : 0;
}

function scoreEntry(
  entry: ProcedureEntry,
  intent: string,
  origin?: string,
  substrate?: string
): number {
  if (substrate && entry.substrate !== substrate) return 0;

  let best = 0;
  for (const phrase of entry.intent_phrases) {
    const s = phraseScore(phrase, intent);
    if (s > best) best = s;
  }
  if (best === 0) return 0;

  // Origin affinity: a *bounded additive* signal in both directions. A strong
  // phrase match must not be silently demoted below auto-execute just because
  // the caller's origin is unknown/mismatched (the dispatcher re-checks origin
  // binding authoritatively before any execution) — bias, don't gate.
  if (origin && entry.target.origins && entry.target.origins.length > 0) {
    const matched = entry.target.origins.some((o) => matchesAllowedOrigin(o, origin));
    best = matched ? Math.min(1.0, best + 0.1) : Math.max(0, best - 0.15);
  }

  return best;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  /** Calling page origin, e.g. "https://s2.kingtime.jp". Used for affinity scoring. */
  origin?: string;
  /** Hard-filter to a single substrate (e.g. "browser"). Optional. */
  substrate?: string;
}

/**
 * Resolve a natural-language intent to a registered ProcedureEntry.
 *
 * Two-stage:
 *  ① Deterministic keyword / phrase scoring (always runs, offline-safe).
 *  ② LLM re-ranking via delegateTask — only when Stage ① cannot produce a
 *     single confident match AND the backend is not the offline stub.
 */
export async function resolveProcedure(
  intent: string,
  opts: ResolveOptions = {}
): Promise<ProcedureResolution> {
  const { autoExecute, learn } = PROCEDURE_RESOLUTION_THRESHOLDS;
  const procedures = loadProcedures().filter((p) => p.status === 'active');

  // --- Stage 1 ----------------------------------------------------------
  const scored = procedures
    .map((entry) => ({
      entry,
      score: scoreEntry(entry, intent, opts.origin, opts.substrate),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  const aboveLearn = scored.filter((x) => x.score >= learn);
  if (aboveLearn.length === 0) {
    return { outcome: 'unmatched', candidates: [], recommendedPattern: 'A' };
  }

  const top = aboveLearn[0];

  // Clear winner: top >= autoExecute with no close second
  const runnerUp = aboveLearn[1];
  if (top.score >= autoExecute && (!runnerUp || runnerUp.score < autoExecute - 0.05)) {
    return {
      outcome: 'matched',
      best: { procedure_id: top.entry.procedure_id, confidence: top.score },
      candidates: aboveLearn.map((x) => ({
        procedure_id: x.entry.procedure_id,
        confidence: x.score,
        reason: 'keyword-match',
      })),
      recommendedPattern: 'B',
    };
  }

  // --- Stage 2: LLM re-ranking (skipped with stub) ----------------------
  const backend = getReasoningBackend();
  if (backend.name !== 'stub') {
    const candidateLines = aboveLearn
      .slice(0, 5)
      .map(
        (x) =>
          `- id="${x.entry.procedure_id}" phrases=${JSON.stringify(x.entry.intent_phrases)} score=${x.score.toFixed(2)}`
      )
      .join('\n');

    try {
      const { candidates: llmCandidates } = await delegateStructured(
        backend,
        [
          `You are ranking intent-to-procedure candidates. User intent: "${intent}"`,
          `Candidates:`,
          candidateLines,
          '',
          `Return a JSON object with a "candidates" array of { "procedure_id": string, "confidence": number, "reason": string },`,
          `sorted by confidence descending. confidence range: 0..1.`,
          `Assign >= ${autoExecute} only when the intent clearly matches. Return {"candidates": []} if none match.`,
        ].join('\n'),
        'procedure_ranking',
        { context: `intent-resolution: "${intent}"` }
      );
      // LLM explicitly returned no matches → override Stage 1
      if (llmCandidates.length === 0) {
        return { outcome: 'unmatched', candidates: [], recommendedPattern: 'A' };
      }
      const llmTop = llmCandidates[0];
      if (llmTop.confidence >= autoExecute) {
        return {
          outcome: 'matched',
          best: { procedure_id: llmTop.procedure_id, confidence: llmTop.confidence },
          candidates: llmCandidates,
          recommendedPattern: 'B',
        };
      }
      if (llmTop.confidence >= learn) {
        return { outcome: 'ambiguous', candidates: llmCandidates, recommendedPattern: 'A' };
      }
      return { outcome: 'unmatched', candidates: [], recommendedPattern: 'A' };
    } catch (err) {
      logger.warn(
        `[procedure-registry] LLM re-ranking failed: ${String(err)} — falling back to Stage 1`
      );
    }
  }

  // Fallback: return Stage 1 ambiguous (stub or LLM error)
  return {
    outcome: 'ambiguous',
    candidates: aboveLearn.map((x) => ({
      procedure_id: x.entry.procedure_id,
      confidence: x.score,
      reason: 'keyword-match',
    })),
    recommendedPattern: 'A',
  };
}
