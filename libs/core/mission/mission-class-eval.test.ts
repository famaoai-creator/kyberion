import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { compileSchemaFromPath } from '../schema-loader.js';
import { withoutSchemaMetadata } from '../test-governance-payload.js';
import { safeReadFile } from '../secure-io.js';
import {
  evaluateMissionClassCorpus,
  loadMissionClassEvalCorpus,
  formatMissionClassEvalReport,
} from './mission-class-eval.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

/**
 * Baseline before the organization classes existed (2026-10-07): overall 10.3%,
 * holdout 0%, class 10.3%. Regressing below these floors means classification
 * quality for organization work has slipped; raise the floors as the corpus and
 * the catalogs improve — never lower them to make a change pass.
 */
const FLOORS = { overall: 0.95, holdout: 0.9, class: 1, team: 1, gates: 1, workflow: 0.95 };

describe('mission class evaluation corpus', () => {
  it('validates against its schema', () => {
    const validate = compileSchemaFromPath(
      new Ajv({ allErrors: true }),
      pathResolver.knowledge('product/schemas/mission-class-eval-corpus.schema.json')
    );
    const corpus = withoutSchemaMetadata(
      JSON.parse(
        safeReadFile(pathResolver.knowledge('product/governance/mission-class-eval-corpus.json'), {
          encoding: 'utf8',
        }) as string
      )
    );
    expect(validate(corpus), JSON.stringify(validate.errors || [])).toBe(true);
  });

  const cases = loadMissionClassEvalCorpus();
  const report = evaluateMissionClassCorpus(cases);
  const detail = formatMissionClassEvalReport(report);

  it('covers every organization class in both dev and holdout splits', () => {
    for (const missionClass of [
      'finance_and_accounting',
      'people_and_talent',
      'legal_and_compliance',
      'strategy_and_governance',
      'procurement_and_supply',
    ]) {
      const splits = new Set(
        cases.filter((entry) => entry.expected_class === missionClass).map((entry) => entry.split)
      );
      expect(splits, `${missionClass} splits`).toEqual(new Set(['dev', 'holdout']));
    }
    expect(new Set(cases.map((entry) => entry.case_id)).size).toBe(cases.length);
  });

  it('checks every dimension on at least one case (no vacuous 100%)', () => {
    for (const [dimension, score] of Object.entries(report.scores)) {
      expect(score.checked, dimension).toBeGreaterThan(0);
    }
  });

  it('keeps classification, workflow, team, and gate selection above the quality floors', () => {
    expect(report.scores.class.rate, detail).toBeGreaterThanOrEqual(FLOORS.class);
    expect(report.scores.team.rate, detail).toBeGreaterThanOrEqual(FLOORS.team);
    expect(report.scores.gates.rate, detail).toBeGreaterThanOrEqual(FLOORS.gates);
    expect(report.scores.workflow.rate, detail).toBeGreaterThanOrEqual(FLOORS.workflow);
    expect(report.overall_rate, detail).toBeGreaterThanOrEqual(FLOORS.overall);
    expect(report.by_split.holdout.overall_rate, detail).toBeGreaterThanOrEqual(FLOORS.holdout);
  });

  it('never routes organization-domain gates onto unrelated work (false-positive guard)', () => {
    const negatives = report.results.filter((result) => result.case_id.startsWith('neg-'));
    expect(negatives.length).toBeGreaterThan(0);
    for (const negative of negatives) {
      expect(negative.failures, `${negative.case_id}\n${detail}`).toEqual([]);
    }
  });
});
