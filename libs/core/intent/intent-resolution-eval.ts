import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';

/**
 * Deterministic evaluation of utterance → selected intent against a labelled
 * corpus. It measures the resolver itself (keyword scoring, tie-breaks), the
 * layer mission classification depends on and cannot repair downstream.
 */

export type IntentResolutionEvalSplit = 'dev' | 'holdout';

export interface IntentResolutionEvalCase {
  case_id: string;
  split: IntentResolutionEvalSplit;
  utterance: string;
  expected_intent_id?: string;
  /** Ordinary request that no catalog intent may claim. */
  expect_no_intent?: boolean;
}

const corpusCatalog = defineCatalog<{ version: string; cases: IntentResolutionEvalCase[] }>({
  id: 'intent-resolution-eval-corpus',
  path: () => pathResolver.knowledge('product/governance/intent-resolution-eval-corpus.json'),
  schema: pathResolver.knowledge('product/schemas/intent-resolution-eval-corpus.schema.json'),
});

export function loadIntentResolutionEvalCorpus(): IntentResolutionEvalCase[] {
  return corpusCatalog.load().cases;
}

export interface IntentResolutionEvalMiss {
  case_id: string;
  split: IntentResolutionEvalSplit;
  utterance: string;
  expected: string;
  actual: string;
}

export interface IntentResolutionEvalReport {
  total: number;
  by_split: Record<IntentResolutionEvalSplit, { total: number; passed: number; rate: number }>;
  /** Cases that expect a specific intent. */
  positive: { total: number; passed: number; rate: number };
  /** Cases that must not resolve to any intent. */
  negative: { total: number; passed: number; rate: number };
  misses: IntentResolutionEvalMiss[];
}

const rate = (passed: number, total: number) => (total === 0 ? 1 : passed / total);

export function evaluateIntentResolutionCorpus(
  cases: IntentResolutionEvalCase[]
): IntentResolutionEvalReport {
  const bySplit = {
    dev: { total: 0, passed: 0, rate: 1 },
    holdout: { total: 0, passed: 0, rate: 1 },
  };
  const positive = { total: 0, passed: 0, rate: 1 };
  const negative = { total: 0, passed: 0, rate: 1 };
  const misses: IntentResolutionEvalMiss[] = [];

  for (const testCase of cases) {
    const actual = resolveIntentResolutionPacket(testCase.utterance).selected_intent_id;
    const expected = testCase.expect_no_intent ? undefined : testCase.expected_intent_id;
    const passed = actual === expected;
    const group = testCase.expect_no_intent ? negative : positive;
    for (const bucket of [bySplit[testCase.split], group]) {
      bucket.total += 1;
      if (passed) bucket.passed += 1;
    }
    if (!passed) {
      misses.push({
        case_id: testCase.case_id,
        split: testCase.split,
        utterance: testCase.utterance,
        expected: expected || '(none)',
        actual: actual || '(none)',
      });
    }
  }
  for (const bucket of [bySplit.dev, bySplit.holdout, positive, negative]) {
    bucket.rate = rate(bucket.passed, bucket.total);
  }
  return { total: cases.length, by_split: bySplit, positive, negative, misses };
}

export function formatIntentResolutionEvalReport(report: IntentResolutionEvalReport): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  return [
    `cases=${report.total} dev=${pct(report.by_split.dev.rate)} holdout=${pct(report.by_split.holdout.rate)} positive=${pct(report.positive.rate)} negative=${pct(report.negative.rate)}`,
    ...report.misses.map(
      (miss) =>
        `  [${miss.split}] ${miss.case_id}: "${miss.utterance}" expected=${miss.expected} actual=${miss.actual}`
    ),
  ].join('\n');
}
