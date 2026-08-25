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
import { pathResolver, resolveFacets, safeExistsSync, safeMkdir, safeReadFile } from '@agent/core';
import { appendJsonLine } from '@agent/core/foundation';
import type { FacetRequest, FacetScope, ResolvedFacets } from '@agent/core';

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
}

export interface EvalHarnessConfigurationResult {
  configuration: string;
  model: string;
  no_tools: boolean;
  prompt_receipts: EvalHarnessPromptReceipt[];
  reload_count: number;
  final_facet_names: string[];
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

export interface RunEvalHarnessTableOptions {
  table: readonly EvalHarnessConfiguration[];
  brief: string;
  steps?: readonly EvalHarnessStep[];
  scope?: FacetScope;
  sessionId?: string;
  runPath?: string;
  executor?: EvalHarnessExecutor;
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
  return JSON.stringify({
    model: context.configuration.model || 'stub',
    no_tools: context.configuration.noTools === true,
    prompt_hash: hash(prompt),
    facet_names: facetNames(context.facets),
    reload_count: context.reloadCount,
  });
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
      promptReceipts.push({
        step: stepIndex,
        prompt_hash: hash(prompt),
        prompt_length: prompt.length,
        output_hash: hash(String(output)),
        output_length: String(output).length,
        reload_count: context.reloadCount,
        facet_names: facetNames(context.facets),
      });
    }
    results.push({
      configuration: configuration.name,
      model: configuration.model || 'stub',
      no_tools: configuration.noTools === true,
      prompt_receipts: promptReceipts,
      reload_count: reloadCount,
      final_facet_names: facetNames(context.facets),
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
  if (!safeExistsSync(filePath)) {
    throw new Error(`[EVAL_HARNESS_CONFIG] table not found: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' })));
  } catch {
    throw new Error(`[EVAL_HARNESS_CONFIG] invalid table JSON: ${filePath}`);
  }
  if (!Array.isArray(parsed)) throw new Error('[EVAL_HARNESS_CONFIG] table root must be an array.');
  return parsed as EvalHarnessConfiguration[];
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
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

if (process.argv[1] && /eval_harness\.(ts|js)$/u.test(process.argv[1])) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
