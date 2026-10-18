/**
 * Blind selection (harness2 import): anonymize outcomes behind seeded letters
 * so a judge compares evidence, not provenance. Output is a RECOMMENDATION —
 * the decision axis remains the sole auto_advance authority.
 */

import type { RunOutcome } from './probe-runner.js';

export interface AnonymizedRow {
  letter: string;
  delivered: boolean;
  exit_code: number | null;
  wall_ms: number;
  produced_files: number;
  error: string;
}

export interface BlindMap {
  seed: number;
  letterToLabel: Record<string, string>;
  labelToLetter: Record<string, string>;
  rows: AnonymizedRow[];
}

export interface BlindRecommendation {
  method: 'llm_blind' | 'metrics_fallback';
  recommended_winner: string;
  letter: string;
  map: BlindMap;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
}

/** mulberry32 — deterministic 32-bit PRNG for seeded shuffles. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function anonymizeOutcomes(outcomes: RunOutcome[], seed: number): BlindMap {
  const rand = mulberry32(seed);
  const labels = outcomes.map((o) => o.label);
  for (let i = labels.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [labels[i], labels[j]] = [labels[j], labels[i]];
  }
  const letterToLabel: Record<string, string> = {};
  const labelToLetter: Record<string, string> = {};
  const rows: AnonymizedRow[] = [];
  labels.forEach((label, i) => {
    const letter = LETTERS[i] ?? `L${i}`;
    letterToLabel[letter] = label;
    labelToLetter[label] = letter;
    const o = outcomes.find((x) => x.label === label)!;
    rows.push({
      letter,
      delivered: o.delivered,
      exit_code: o.exit_code,
      wall_ms: o.wall_ms,
      produced_files: o.produced_files.length,
      error: o.error,
    });
  });
  return { seed, letterToLabel, labelToLetter, rows };
}

export type BlindSelector = (rows: AnonymizedRow[]) => string;

/** Deterministic fallback selector: lowest wall_ms among delivered rows. */
export const metricsFallbackSelector: BlindSelector = (rows) => {
  const delivered = rows.filter((r) => r.delivered);
  if (!delivered.length) return rows[0]?.letter ?? '';
  return delivered.sort((a, b) => a.wall_ms - b.wall_ms)[0].letter;
};

export function applyBlindSelection(
  outcomes: RunOutcome[],
  seed: number,
  selector: BlindSelector = metricsFallbackSelector,
  method?: BlindRecommendation['method']
): BlindRecommendation | null {
  if (!outcomes.length) return null;
  const map = anonymizeOutcomes(outcomes, seed);
  const letter = selector(map.rows);
  const recommended = map.letterToLabel[letter];
  if (!recommended) return null;
  const chosen = outcomes.find((o) => o.label === recommended)!;
  return {
    method: method ?? (selector === metricsFallbackSelector ? 'metrics_fallback' : 'llm_blind'),
    recommended_winner: recommended,
    letter,
    map,
    confidence: chosen.delivered ? 'medium' : 'low',
    rationale: `blind selection picked ${letter} -> ${recommended} (delivered=${chosen.delivered}); recommendation only — the decision axis governs advancement`,
  };
}
