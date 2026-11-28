import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeRmSync } from '@agent/core/secure-io';
import {
  createHybridSemanticJudgmentInvokePort,
  type LiveJudgmentInvokePort,
} from '@agent/core/organization';
import {
  compareSemanticJudgmentEvalReports,
  exportOpenAiEvalsBundle,
  formatSemanticJudgmentEvalMarkdown,
  main as runEvalMain,
  runSemanticJudgmentEval,
} from './run_semantic_judgment_eval.js';

describe('run_semantic_judgment_eval', () => {
  it('computes precision, recall (including unavailable in denominator), negative refusal rate, and false-apply counts', async () => {
    const latencies = [10, 20, 30, 40, 50];
    let index = 0;
    const mockPort: LiveJudgmentInvokePort = {
      mode: 'live_api',
      provider: 'local',
      model: 'mock-judge',
      async invoke(input) {
        // Extract the source_key, goal_key, and proposal_key from the HTML-escaped framed JSON payload
        const sourceMatch = input.prompt.match(
          /(?:"|&quot;)source_key(?:"|&quot;):(?:"|&quot;)(src-[a-f0-9]+)(?:"|&quot;)/u
        );
        const goalMatch = input.prompt.match(
          /(?:"|&quot;)goal_key(?:"|&quot;):(?:"|&quot;)([^"&]+)(?:"|&quot;)/u
        );
        const proposalMatch = input.prompt.match(
          /(?:"|&quot;)proposal_key(?:"|&quot;):(?:"|&quot;)([^"&]+)(?:"|&quot;)/u
        );
        const sourceKey = sourceMatch?.[1] ?? 'src-unknown';
        const goalKey = goalMatch?.[1] ?? 'synthetic-latency-goal';
        const proposalKey = proposalMatch?.[1] ?? 'repair_fixture';

        index++;
        if (proposalKey === 'repair_fixture') {
          // Force one case to return invalid JSON so unavailable appears in the denominator
          if (index === 1) {
            return { text: '{broken', usage: { input_tokens: 50, output_tokens: 10 } };
          }
          return {
            text: JSON.stringify({
              disposition: 'apply_precedent',
              precedent_keys: [sourceKey],
              rationale: 'Preserves goal constraints.',
              applicability: ['isolated_fixture_only'],
            }),
            usage: { input_tokens: 100, output_tokens: 30 },
          };
        }
        if (proposalKey === 'limit_users' || proposalKey === 'accept_latency') {
          return {
            text: JSON.stringify({
              disposition: 'reframe',
              violated_goal_keys: [goalKey],
              rationale: 'Relaxes target constraint.',
              revised_question: 'How to meet 100 users and 500ms?',
              evidence_needed: [],
            }),
            usage: { input_tokens: 110, output_tokens: 35 },
          };
        }
        return {
          text: JSON.stringify({
            disposition: 'escalate',
            rationale: 'Exceeds 0 JPY budget.',
            question: 'Accept 1000 JPY monthly cost?',
            options: [
              { label: 'Accept', consequences: '+1000 JPY/mo' },
              { label: 'Reject', consequences: 'Keep 0 JPY cap' },
            ],
            missing_facts: [],
          }),
          usage: { input_tokens: 120, output_tokens: 40 },
        };
      },
    };

    let clock = 1_700_000_000_000;
    const report = await runSemanticJudgmentEval({
      port: mockPort,
      nowMs: () => {
        clock += latencies[index % latencies.length];
        return clock;
      },
    });

    expect(report.total).toBe(80);
    expect(report.false_apply_count).toBe(0);
    // 19 of 20 apply_precedent succeeded (1 failed invalid_schema in denominator)
    expect(report.branches.apply_precedent.tp).toBe(19);
    expect(report.branches.apply_precedent.fn).toBe(1);
    expect(report.branches.apply_precedent.recall).toBeCloseTo(19 / 20);
    expect(report.branches.reframe.recall).toBe(1);
    expect(report.branches.escalate.recall).toBe(1);
    // All 20 negative cases must be refused fail-closed as unavailable.
    expect(report.negative_total).toBe(20);
    expect(report.negative_refused).toBe(20);
    expect(report.negative_refusal_rate).toBe(1);
    expect(report.total_input_tokens).toBeGreaterThan(0);
    expect(report.total_output_tokens).toBeGreaterThan(0);

    const md = formatSemanticJudgmentEvalMarkdown(report);
    expect(md).toContain('T14 Live Semantic Judgment Evaluation (local / mock-judge)');
    expect(md).toContain('| `apply_precedent` |');
  });

  it('exports a 60-case OpenAI Evals bundle into a safe repo temp path', async () => {
    const outDir = pathResolver.rootResolve(
      `active/shared/tmp/t14-evals-test-${Date.now().toString(36)}`
    );
    try {
      const bundle = await exportOpenAiEvalsBundle({ outputDir: outDir, model: 'gpt-4o-mini' });
      expect(bundle.caseCount).toBe(60);
      const lines = String(safeReadFile(bundle.datasetPath, { encoding: 'utf8' }))
        .trim()
        .split('\n');
      expect(lines).toHaveLength(60);
      const first = JSON.parse(lines[0]) as { item: Record<string, unknown> };
      expect(first.item).toMatchObject({
        id: expect.any(String),
        expected_disposition: expect.stringMatching(/^(apply_precedent|reframe|escalate)$/u),
        prompt: expect.stringContaining('<untrusted_data'),
      });
      const config = JSON.parse(String(safeReadFile(bundle.configPath, { encoding: 'utf8' }))) as {
        testing_criteria: Array<{ operation: string }>;
        run_template: { data_source: { model: string } };
      };
      expect(config.testing_criteria[0].operation).toBe('eq');
      expect(config.run_template.data_source.model).toBe('gpt-4o-mini');
      expect(path.basename(bundle.configPath)).toBe('eval_config.json');
    } finally {
      safeRmSync(outDir, { recursive: true, force: true });
    }
  });

  it('maintains 0 false-apply and 100% negative refusal with hybrid role-split routing', async () => {
    const extractKeys = (prompt: string) => ({
      sourceKey:
        prompt.match(
          /(?:"|&quot;)source_key(?:"|&quot;):(?:"|&quot;)(src-[a-f0-9]+)(?:"|&quot;)/u
        )?.[1] ?? 'src-unknown',
      goalKey:
        prompt.match(/(?:"|&quot;)goal_key(?:"|&quot;):(?:"|&quot;)([^"&]+)(?:"|&quot;)/u)?.[1] ??
        'synthetic-latency-goal',
      proposalKey:
        prompt.match(
          /(?:"|&quot;)proposal_key(?:"|&quot;):(?:"|&quot;)([^"&]+)(?:"|&quot;)/u
        )?.[1] ?? 'repair_fixture',
    });

    const primary: LiveJudgmentInvokePort = {
      mode: 'live_api',
      provider: 'laya-mlx',
      model: 'aac6fef/laya-multilingual-mlx',
      async invoke(input) {
        const { sourceKey, proposalKey } = extractKeys(input.prompt);
        const confidentApply = proposalKey === 'repair_fixture';
        return {
          text: JSON.stringify({
            disposition: confidentApply ? 'apply_precedent' : 'escalate',
            ...(confidentApply
              ? { precedent_keys: [sourceKey], applicability: ['isolated_fixture_only'] }
              : {
                  question: 'Escalate?',
                  options: [
                    { label: 'Approve', consequences: 'Adds cost' },
                    { label: 'Reject', consequences: 'Zero cost' },
                  ],
                  missing_facts: [],
                }),
            rationale: 'Primary classifier output.',
          }),
          usage: { input_tokens: 0, output_tokens: 0 },
          meta: {
            disposition: confidentApply ? 'apply_precedent' : 'escalate',
            confidence: confidentApply ? 0.96 : 0.45,
          },
        };
      },
    };

    let fallbackCalls = 0;
    const fallback: LiveJudgmentInvokePort = {
      mode: 'live_api',
      provider: 'openai',
      model: 'gpt-4o-mini',
      async invoke(input) {
        fallbackCalls += 1;
        const { goalKey, proposalKey } = extractKeys(input.prompt);
        if (proposalKey === 'limit_users' || proposalKey === 'accept_latency') {
          return {
            text: JSON.stringify({
              disposition: 'reframe',
              violated_goal_keys: [goalKey],
              rationale: 'Reframe weakened goal.',
              revised_question: 'Preserve goal?',
              evidence_needed: [],
            }),
            usage: { input_tokens: 100, output_tokens: 30 },
          };
        }
        return {
          text: JSON.stringify({
            disposition: 'escalate',
            rationale: 'Cost decision.',
            question: 'Accept cost?',
            options: [
              { label: 'Approve', consequences: '+1000 JPY' },
              { label: 'Reject', consequences: '0 JPY' },
            ],
            missing_facts: [],
          }),
          usage: { input_tokens: 110, output_tokens: 35 },
        };
      },
    };

    const hybrid = createHybridSemanticJudgmentInvokePort({ primary, fallback });
    let clock = 1_700_000_000_000;
    const report = await runSemanticJudgmentEval({
      port: hybrid,
      nowMs: () => {
        clock += 20;
        return clock;
      },
    });
    expect(report.total).toBe(80);
    expect(report.false_apply_count).toBe(0);
    expect(report.negative_refusal_rate).toBe(1);
    expect(report.branches.apply_precedent.recall).toBe(1);
    expect(report.branches.reframe.recall).toBe(1);
    expect(report.branches.escalate.recall).toBe(1);
    // Primary handled the 20 repair_fixture cases; fallback handled reframe/escalate (40 positive cases).
    expect(fallbackCalls).toBe(40);
    expect(report.routing.primary).toBe(20);
    expect(report.routing.fallback).toBe(40);
    expect(report.positive_tokens_per_case).toBeGreaterThan(0);

    const baselineLike = {
      ...report,
      provider: 'laya-mlx',
      model: 'aac6fef/laya-multilingual-mlx',
      p50_latency_ms: 34,
      positive_tokens_per_case: 0,
      branches: {
        ...report.branches,
        reframe: { tp: 1, fp: 0, fn: 19, precision: 1, recall: 0.05 },
      },
    };
    const comparison = compareSemanticJudgmentEvalReports(report, baselineLike);
    expect(comparison.branch_deltas.reframe.recall_delta).toBeCloseTo(0.95);
    const md = formatSemanticJudgmentEvalMarkdown(report, comparison);
    expect(md).toContain('Routing: primary=20, fallback=40');
    expect(md).toContain('## Comparison vs Baseline (laya-mlx / aac6fef/laya-multilingual-mlx)');
  });

  it('prints CLI usage for --help and groups failures into failure_clusters', async () => {
    const out: string[] = [];
    const exitCode = await runEvalMain(['--help'], (line) => out.push(line));
    expect(exitCode).toBe(0);
    expect(out.join('\n')).toContain('--compare <baseline.json>');
    expect(out.join('\n')).toContain('--hybrid-fallback');
    expect(out.join('\n')).toContain('--hybrid-min-confidence');

    const alwaysApplyPort: LiveJudgmentInvokePort = {
      mode: 'live_api',
      provider: 'local',
      model: 'always-apply',
      async invoke(input) {
        const sourceKey =
          input.prompt.match(
            /(?:"|&quot;)source_key(?:"|&quot;):(?:"|&quot;)(src-[a-f0-9]+)(?:"|&quot;)/u
          )?.[1] ?? 'src-1';
        return {
          text: JSON.stringify({
            disposition: 'apply_precedent',
            precedent_keys: [sourceKey],
            rationale: 'Naive.',
            applicability: ['isolated_fixture_only'],
          }),
          usage: { input_tokens: 10, output_tokens: 10 },
        };
      },
    };
    const report = await runSemanticJudgmentEval({ port: alwaysApplyPort, onlyPositive: true });
    expect(report.failure_clusters.length).toBeGreaterThan(0);
    expect(report.failure_clusters[0].count).toBe(20);
    const md = formatSemanticJudgmentEvalMarkdown(report);
    expect(md).toContain('## Failure Clusters');
  });
});
