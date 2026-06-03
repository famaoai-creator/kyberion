import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import {
  buildOperatorRequestLogFromIntentResolution,
  type OperatorRequestLog,
} from './operator-learning.js';
import { resolveIntentResolutionPacket } from './intent-resolution.js';
import { safeReadFile } from './secure-io.js';

const Ajv = (AjvModule as any).default ?? AjvModule;

function loadScenarioPack() {
  return JSON.parse(
    safeReadFile(
      pathResolver.knowledge('product/governance/operator-learning-scenario-pack.json'),
      { encoding: 'utf8' }
    ) as string
  );
}

function flattenSignals(log: OperatorRequestLog): string[] {
  return [
    log.signals.decision_style_observed,
    ...(log.signals.terminology_observed || []),
    ...(log.signals.approval_threshold_observed || []),
    ...(log.signals.recurring_task_candidate || []),
    ...(log.signals.correction_signals || []),
  ].filter((value): value is string => Boolean(value));
}

describe('operator-learning scenario pack', () => {
  it('validates the governed operator scenario pack schema', () => {
    const ajv = new Ajv({ allErrors: true });
    const validate = compileSchemaFromPath(
      ajv,
      pathResolver.knowledge('product/schemas/operator-learning-scenario-pack.schema.json')
    );
    const pack = loadScenarioPack();

    expect(validate(pack), JSON.stringify(validate.errors || [])).toBe(true);
  });

  it('resolves representative CEO/CTO scenarios into stable learning logs', () => {
    const pack = loadScenarioPack();
    for (const [index, scenario] of (pack.scenarios || []).entries()) {
      const packet =
        scenario.scenario_class === 'controlled-failure' &&
        scenario.expected_intent_id === 'unresolved_intent'
          ? {
              kind: 'intent_resolution_packet',
              utterance: scenario.utterance,
              candidates: [],
            }
          : resolveIntentResolutionPacket(scenario.utterance);

      const log = buildOperatorRequestLogFromIntentResolution({
        packet,
        profileId: 'ceo-cto-hybrid',
        surface: 'terminal',
        receivedAt: `2026-04-29T10:${String(index).padStart(2, '0')}:00.000Z`,
        clarificationQuestions:
          scenario.scenario_class === 'controlled-failure'
            ? ['対象と期待する成果物は何ですか？']
            : undefined,
      });

      expect(log.normalized_intent.intent_id).toBe(scenario.expected_intent_id);
      expect(log.normalized_intent.task_family).toBe(scenario.expected_task_family);
      expect(log.route.shape).toBe(scenario.expected_route_shape);
      expect(flattenSignals(log)).toEqual(
        expect.arrayContaining(scenario.expected_signals)
      );

      if (scenario.expected_verification_result) {
        expect(log.verification.result).toBe(scenario.expected_verification_result);
      }
      if (scenario.expected_learning_update) {
        expect(log.learning_update.candidate_created).toBe(
          scenario.expected_learning_update.candidate_created
        );
        expect(log.learning_update.promote_eligible).toBe(
          scenario.expected_learning_update.promote_eligible
        );
      }
    }
  });

  it('covers all 4 scenario classes with at least the minimum required count', () => {
    const pack = loadScenarioPack();
    const byClass: Record<string, number> = {};
    for (const scenario of pack.scenarios || []) {
      const c: string = scenario.scenario_class || 'unknown';
      byClass[c] = (byClass[c] || 0) + 1;
    }
    expect(byClass['golden'] ?? 0).toBeGreaterThanOrEqual(10);
    expect(byClass['controlled-failure'] ?? 0).toBeGreaterThanOrEqual(3);
    expect(byClass['ambiguous'] ?? 0).toBeGreaterThanOrEqual(2);
    expect(byClass['approval-sensitive'] ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('has at least one controlled-failure scenario per risk category (dependency, authority, missing-input)', () => {
    const pack = loadScenarioPack();
    const failures: string[] = (pack.scenarios || [])
      .filter((s: { scenario_class: string }) => s.scenario_class === 'controlled-failure')
      .map((s: { notes?: string; utterance?: string }) => `${s.notes || ''} ${s.utterance || ''}`);

    const hasDependency = failures.some((t) => /depend|missing|tts|stt|voice/i.test(t));
    const hasAuthority = failures.some((t) => /authority|policy|secret|block/i.test(t));
    const hasMissingInput = failures.some((t) => /url|missing|clarif/i.test(t));

    expect(hasDependency).toBe(true);
    expect(hasAuthority).toBe(true);
    expect(hasMissingInput).toBe(true);
  });
});
