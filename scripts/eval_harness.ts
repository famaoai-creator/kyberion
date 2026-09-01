/**
 * PI-18: deterministic, named eval harness table.
 *
 * The runner deliberately keeps provider execution injectable. The default
 * executor records a request envelope, which makes the table and reload
 * contract useful in CI without credentials; a live provider adapter can be
 * supplied by an explicit caller when required.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  resolveFacets,
  type FacetRequest,
  type FacetScope,
  type ResolvedFacets,
} from '@agent/core/facet-registry';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
} from '@agent/core/secure-io';
import { appendJsonLine, readJson } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';
import { evaluateResolvedFacetFixtures } from './eval_facets.js';

export interface EvalHarnessConfiguration {
  name: string;
  model?: string;
  noTools?: boolean;
  systemPrompt?: string;
  facet_request?: FacetRequest;
}

export type EvalHarnessStep = { type: 'prompt'; prompt: string } | { type: 'reload' };

export interface EvalHarnessContext {
  configuration: EvalHarnessConfiguration;
  systemPrompt: string;
  facets: ResolvedFacets;
  reloadCount: number;
}

export interface EvalHarnessPromptReceipt {
  step: number;
  prompt_hash: string;
  prompt_length: number;
  output_hash: string;
  output_length: number;
  reload_count: number;
  facet_names: string[];
  /** Digest only; facet content and paths never enter the persisted receipt. */
  facet_content_hash: string;
  facet_contract_status: EvalHarnessFacetContractStatus;
  facet_contract_finding_hashes: string[];
  quality_status: EvalHarnessQualityStatus;
  quality_score: number;
  quality_finding_hashes: string[];
}

export type EvalHarnessQualityStatus = 'pass' | 'warn' | 'fail';
export type EvalHarnessFacetContractStatus = 'pass' | 'fail' | 'not_evaluated';

export interface EvalHarnessQualityVerdict {
  status: EvalHarnessQualityStatus;
  score: number;
  findings: string[];
}

export interface EvalHarnessQualityJudgeInput {
  prompt: string;
  output: string;
  context: EvalHarnessContext;
}

export interface EvalHarnessConfigurationResult {
  configuration: string;
  model: string;
  no_tools: boolean;
  prompt_receipts: EvalHarnessPromptReceipt[];
  reload_count: number;
  final_facet_names: string[];
  final_facet_content_hash: string;
  facet_contract: {
    status: EvalHarnessFacetContractStatus;
    evaluated: number;
    findings_count: number;
  };
  quality: {
    status: EvalHarnessQualityStatus;
    average_score: number;
    findings_count: number;
  };
}

export interface EvalHarnessTableResult {
  schema_version: 'pi-eval-harness.v1';
  run_id: string;
  session_id: string;
  brief_hash: string;
  step_types: EvalHarnessStep['type'][];
  results: EvalHarnessConfigurationResult[];
}

export type EvalHarnessExecutor = (
  prompt: string,
  context: EvalHarnessContext
) => Promise<string> | string;

export type EvalHarnessQualityJudge = (
  input: EvalHarnessQualityJudgeInput
) => Promise<EvalHarnessQualityVerdict> | EvalHarnessQualityVerdict;

export interface RunEvalHarnessTableOptions {
  table: readonly EvalHarnessConfiguration[];
  brief: string;
  steps?: readonly EvalHarnessStep[];
  scope?: FacetScope;
  sessionId?: string;
  runPath?: string;
  executor?: EvalHarnessExecutor;
  qualityJudge?: EvalHarnessQualityJudge;
}

// Runtime receipts belong under the governed shared temporary tier. A
// root-level `.eval/` directory and arbitrary shared subdirectories are
// intentionally rejected by secure-io policy.
const DEFAULT_RUN_PATH = pathResolver.sharedTmp('eval/runs.jsonl');

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeConfiguration(configuration: EvalHarnessConfiguration): EvalHarnessConfiguration {
  const name = String(configuration.name || '').trim();
  if (!name) throw new Error('[EVAL_HARNESS_CONFIG] configuration name is required.');
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(name)) {
    throw new Error(`[EVAL_HARNESS_CONFIG] invalid configuration name: ${name}`);
  }
  return {
    ...configuration,
    name,
    model: String(configuration.model || 'stub').trim() || 'stub',
    noTools: configuration.noTools === true,
    ...(configuration.systemPrompt ? { systemPrompt: configuration.systemPrompt } : {}),
    ...(configuration.facet_request ? { facet_request: configuration.facet_request } : {}),
  };
}

function validateTable(table: readonly EvalHarnessConfiguration[]): EvalHarnessConfiguration[] {
  if (table.length === 0) throw new Error('[EVAL_HARNESS_CONFIG] table must not be empty.');
  const seen = new Set<string>();
  return table.map((configuration) => {
    const normalized = normalizeConfiguration(configuration);
    if (seen.has(normalized.name)) {
      throw new Error(`[EVAL_HARNESS_CONFIG] duplicate configuration: ${normalized.name}`);
    }
    seen.add(normalized.name);
    return normalized;
  });
}

function facetNames(facets: ResolvedFacets): string[] {
  return [facets.persona, ...facets.policies, ...facets.instructions, facets.output_contract]
    .filter((facet): facet is NonNullable<typeof facet> => Boolean(facet))
    .map((facet) => `${facet.kind}:${facet.name}`)
    .sort();
}

function facetContentHash(facets: ResolvedFacets): string {
  const entries = [
    facets.persona,
    ...facets.policies,
    ...facets.instructions,
    facets.output_contract,
  ]
    .filter((facet): facet is NonNullable<typeof facet> => Boolean(facet))
    .map((facet) => ({ kind: facet.kind, name: facet.name, content: facet.content }));
  return hash(JSON.stringify(entries));
}

function facetContractSummary(facets: ResolvedFacets): {
  status: EvalHarnessFacetContractStatus;
  evaluated: number;
  finding_hashes: string[];
} {
  const results = evaluateResolvedFacetFixtures(facets);
  const findingHashes = results.flatMap((result) => result.findings.map(hash));
  return {
    status:
      results.length === 0
        ? 'not_evaluated'
        : results.every((result) => result.passed)
          ? 'pass'
          : 'fail',
    evaluated: results.length,
    finding_hashes: findingHashes,
  };
}

function contextFor(
  configuration: EvalHarnessConfiguration,
  scope: FacetScope,
  reloadCount: number
): EvalHarnessContext {
  const facets = resolveFacets(configuration.facet_request || {}, scope);
  return {
    configuration,
    systemPrompt: configuration.systemPrompt || '',
    facets,
    reloadCount,
  };
}

function defaultExecutor(prompt: string, context: EvalHarnessContext): string {
  const facetContract = facetContractSummary(context.facets);
  return JSON.stringify({
    model: context.configuration.model || 'stub',
    no_tools: context.configuration.noTools === true,
    prompt_hash: hash(prompt),
    facet_names: facetNames(context.facets),
    facet_content_hash: facetContentHash(context.facets),
    facet_contract_status: facetContract.status,
    facet_contract_finding_hashes: facetContract.finding_hashes,
    reload_count: context.reloadCount,
  });
}

/**
 * Credential-free structural judge used by CI. It deliberately does not
 * claim semantic quality: provider-backed callers can inject a real judge,
 * while every receipt still records an explicit, conservative verdict.
 */
export function defaultEvalHarnessQualityJudge({
  output,
}: EvalHarnessQualityJudgeInput): EvalHarnessQualityVerdict {
  if (!output.trim()) {
    return { status: 'fail', score: 0, findings: ['output is empty'] };
  }
  return { status: 'pass', score: 100, findings: [] };
}

function normalizeQualityVerdict(value: unknown): EvalHarnessQualityVerdict {
  if (!value || typeof value !== 'object') {
    throw new Error('[EVAL_HARNESS_QUALITY] judge returned a non-object verdict.');
  }
  const verdict = value as Record<string, unknown>;
  const status = verdict.status;
  const score = verdict.score;
  const findings = verdict.findings;
  if (status !== 'pass' && status !== 'warn' && status !== 'fail') {
    throw new Error('[EVAL_HARNESS_QUALITY] judge returned an invalid status.');
  }
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error('[EVAL_HARNESS_QUALITY] judge returned an invalid score.');
  }
  if (
    !Array.isArray(findings) ||
    findings.some((finding) => typeof finding !== 'string' || !finding.trim())
  ) {
    throw new Error('[EVAL_HARNESS_QUALITY] judge returned invalid findings.');
  }
  return {
    status,
    score,
    findings: findings.map((finding) => finding.trim()),
  };
}

function aggregateQuality(
  receipts: EvalHarnessPromptReceipt[]
): EvalHarnessConfigurationResult['quality'] {
  if (receipts.length === 0) {
    return { status: 'pass', average_score: 100, findings_count: 0 };
  }
  const averageScore =
    receipts.reduce((sum, receipt) => sum + receipt.quality_score, 0) / receipts.length;
  const status = receipts.some((receipt) => receipt.quality_status === 'fail')
    ? 'fail'
    : receipts.some((receipt) => receipt.quality_status === 'warn')
      ? 'warn'
      : 'pass';
  return {
    status,
    average_score: Number(averageScore.toFixed(3)),
    findings_count: receipts.reduce(
      (sum, receipt) => sum + receipt.quality_finding_hashes.length,
      0
    ),
  };
}

function appendRunRecord(runPath: string, result: EvalHarnessTableResult): void {
  const directory = path.dirname(runPath);
  if (!safeExistsSync(directory)) safeMkdir(directory, { recursive: true });
  appendJsonLine(runPath, { ...result, recorded_at: new Date().toISOString() });
}

/** Run every named configuration against the same ordered multi-step brief. */
export async function runEvalHarnessTable(
  options: RunEvalHarnessTableOptions
): Promise<EvalHarnessTableResult> {
  const table = validateTable(options.table);
  const brief = String(options.brief || '').trim();
  if (!brief) throw new Error('[EVAL_HARNESS_INPUT] brief is required.');
  const steps: EvalHarnessStep[] = options.steps?.length
    ? [...options.steps]
    : [{ type: 'prompt', prompt: brief }];
  const scope = options.scope || { tier: 'public' as const };
  const executor = options.executor || defaultExecutor;
  const qualityJudge = options.qualityJudge || defaultEvalHarnessQualityJudge;
  const results: EvalHarnessConfigurationResult[] = [];

  for (const configuration of table) {
    let reloadCount = 0;
    let context = contextFor(configuration, scope, reloadCount);
    const promptReceipts: EvalHarnessPromptReceipt[] = [];
    for (const [stepIndex, step] of steps.entries()) {
      if (step.type === 'reload') {
        reloadCount += 1;
        context = contextFor(configuration, scope, reloadCount);
        continue;
      }
      const prompt = String(step.prompt || '').trim();
      if (!prompt) throw new Error(`[EVAL_HARNESS_INPUT] empty prompt at step ${stepIndex + 1}.`);
      const output = await executor(prompt, context);
      const outputText = String(output);
      const quality = normalizeQualityVerdict(
        await qualityJudge({ prompt, output: outputText, context })
      );
      const facetContract = facetContractSummary(context.facets);
      promptReceipts.push({
        step: stepIndex,
        prompt_hash: hash(prompt),
        prompt_length: prompt.length,
        output_hash: hash(outputText),
        output_length: outputText.length,
        reload_count: context.reloadCount,
        facet_names: facetNames(context.facets),
        facet_content_hash: facetContentHash(context.facets),
        facet_contract_status: facetContract.status,
        facet_contract_finding_hashes: facetContract.finding_hashes,
        quality_status: quality.status,
        quality_score: quality.score,
        // Findings can contain model-produced excerpts. Keep the persisted
        // receipt hash-only, matching the rest of this harness contract.
        quality_finding_hashes: quality.findings.map(hash),
      });
    }
    const finalFacetContract = facetContractSummary(context.facets);
    results.push({
      configuration: configuration.name,
      model: configuration.model || 'stub',
      no_tools: configuration.noTools === true,
      prompt_receipts: promptReceipts,
      reload_count: reloadCount,
      final_facet_names: facetNames(context.facets),
      final_facet_content_hash: facetContentHash(context.facets),
      facet_contract: {
        status: finalFacetContract.status,
        evaluated: finalFacetContract.evaluated,
        findings_count: finalFacetContract.finding_hashes.length,
      },
      quality: aggregateQuality(promptReceipts),
    });
  }

  const result: EvalHarnessTableResult = {
    schema_version: 'pi-eval-harness.v1',
    run_id: `eval-${randomUUID()}`,
    session_id: options.sessionId || `session-${randomUUID()}`,
    brief_hash: hash(brief),
    step_types: steps.map((step) => step.type),
    results,
  };
  appendRunRecord(options.runPath || DEFAULT_RUN_PATH, result);
  return result;
}

export function loadEvalHarnessTable(
  filePath = pathResolver.rootResolve('eval/harnesses.json')
): EvalHarnessConfiguration[] {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath)) {
    throw new Error(`[EVAL_HARNESS_CONFIG] table not found: ${filePath}`);
  }
  if (!safeLstat(safePath).isFile()) {
    throw new Error(`[EVAL_HARNESS_CONFIG] table must be a regular file: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = readJson<unknown>(safePath);
  } catch {
    throw new Error(`[EVAL_HARNESS_CONFIG] invalid table JSON: ${filePath}`);
  }
  if (!Array.isArray(parsed)) throw new Error('[EVAL_HARNESS_CONFIG] table root must be an array.');
  return parsed as EvalHarnessConfiguration[];
}

export async function main(argv: string[] = []): Promise<number> {
  const table = loadEvalHarnessTable();
  const briefIndex = argv.indexOf('--brief');
  const brief =
    briefIndex >= 0 ? String(argv[briefIndex + 1] || '') : 'evaluate the configured brief';
  const reload = argv.includes('--reload');
  const result = await runEvalHarnessTable({
    table,
    brief,
    steps: [
      { type: 'prompt', prompt: brief },
      ...(reload ? ([{ type: 'reload' }, { type: 'prompt', prompt: brief }] as const) : []),
    ],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

if (
  isDirectScript(import.meta.url, 'eval_harness.ts') ||
  isDirectScript(import.meta.url, 'eval_harness.js')
)
  void defineScript({
    name: 'eval:harness',
    flags: [],
    async run(context) {
      const status = await main(context.argv);
      if (status !== 0) throw new Error(`eval harness failed with exit code ${status}`);
    },
  })();
