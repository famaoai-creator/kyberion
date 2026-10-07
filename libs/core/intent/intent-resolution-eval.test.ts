import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { compileSchemaFromPath } from '../schema-loader.js';
import { safeReadFile } from '../secure-io.js';
import { withoutSchemaMetadata } from '../test-governance-payload.js';
import {
  evaluateIntentResolutionCorpus,
  formatIntentResolutionEvalReport,
  loadIntentResolutionEvalCorpus,
} from './intent-resolution-eval.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

/**
 * Baseline before the keyword review (2026-10-08), same corpus: dev 63.1%,
 * holdout 43.5% on the first 46 holdout cases (44.1% on a later, unseen set).
 * Raise the floors as the corpus and the catalog improve — never lower them to
 * make a change pass. Add new holdout cases rather than tuning to existing ones.
 */
const FLOORS = { dev: 0.95, holdout: 0.85, positive: 0.9, negative: 0.8 };

describe('intent resolution evaluation corpus', () => {
  it('validates against its schema', () => {
    const validate = compileSchemaFromPath(
      new Ajv({ allErrors: true }),
      pathResolver.knowledge('product/schemas/intent-resolution-eval-corpus.schema.json')
    );
    const corpus = withoutSchemaMetadata(
      JSON.parse(
        safeReadFile(
          pathResolver.knowledge('product/governance/intent-resolution-eval-corpus.json'),
          { encoding: 'utf8' }
        ) as string
      )
    );
    expect(validate(corpus), JSON.stringify(validate.errors || [])).toBe(true);
  });

  const cases = loadIntentResolutionEvalCorpus();
  const report = evaluateIntentResolutionCorpus(cases);

  it('keeps intent selection above the quality floors', () => {
    const detail = formatIntentResolutionEvalReport(report);
    expect(report.by_split.dev.rate, detail).toBeGreaterThanOrEqual(FLOORS.dev);
    expect(report.by_split.holdout.rate, detail).toBeGreaterThanOrEqual(FLOORS.holdout);
    expect(report.positive.rate, detail).toBeGreaterThanOrEqual(FLOORS.positive);
    expect(report.negative.rate, detail).toBeGreaterThanOrEqual(FLOORS.negative);
  });

  it('does not let ordinary code requests be absorbed by catalog intents', () => {
    expect(report.negative.total).toBeGreaterThanOrEqual(15);
  });

  it('keeps every intent id in the corpus real', () => {
    const ids = new Set(
      (
        JSON.parse(
          safeReadFile(pathResolver.knowledge('product/governance/standard-intents.json'), {
            encoding: 'utf8',
          }) as string
        ).intents as Array<{ id: string }>
      ).map((intent) => intent.id)
    );
    for (const testCase of cases) {
      if (testCase.expected_intent_id) {
        expect(ids.has(testCase.expected_intent_id), testCase.case_id).toBe(true);
      }
    }
  });
});
