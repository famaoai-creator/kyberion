/**
 * Read-only comparison run: one instruction to every eligible provider,
 * judged without writing the repository. Palettes decide when this may
 * run; live CLI fan-out still requires KYBERION_BEST_OF_PROVIDERS_LIVE=1.
 */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir } from './secure-io.js';
import { appendJsonLine, parseSafeJsonObjectValue, readJsonLines } from './foundation/json.js';
import { buildCognitiveRouteDecision, type CognitiveRouteDecision } from './cognitive-routing.js';
import {
  loadCognitiveRoutingPalette,
  resolveRoutingOptimizeMode,
  type RoutingOptimizeMode,
} from './cognitive-routing-palette.js';
import {
  BEST_OF_PROVIDERS_LIVE_ENV_VAR,
  peekBestOfProvidersVerdictLog,
  runBestOfProviders,
  type BestOfProviderCandidate,
  type BestOfProvidersResult,
  type BestOfProvidersSeams,
} from './best-of-providers.js';
import type { TierLevel } from './types.js';

export const ROUTING_COMPARE_LOG_RELATIVE_PATH = 'runtime/cognitive-routing/comparisons.jsonl';

export interface RoutingTaxonomyLabels {
  domain: string;
  task: string;
  modifier: string;
}

export interface RoutingCompareAdmission {
  run: boolean;
  reason: string;
  mode: RoutingOptimizeMode;
  fanout: string;
}

export interface RoutingComparePlan {
  instruction_digest: string;
  optimize_for: RoutingOptimizeMode;
  labels: RoutingTaxonomyLabels;
  cognitive: CognitiveRouteDecision;
  admission: RoutingCompareAdmission;
  live_env_required: typeof BEST_OF_PROVIDERS_LIVE_ENV_VAR;
  live_env_set: boolean;
}

export interface RoutingCompareRunOptions {
  instruction: string;
  context?: string;
  dataTier?: TierLevel;
  optimizeFor?: string;
  explicit?: boolean;
  live?: boolean;
  providers?: string[];
  candidates?: BestOfProviderCandidate[];
  missionId?: string;
  seams?: BestOfProvidersSeams;
  comparisonLogPath?: string;
}

export interface RoutingCompareResult {
  plan: RoutingComparePlan;
  executed: boolean;
  comparison?: BestOfProvidersResult;
}

const DOMAIN_MARKERS: Array<{ id: string; markers: string[] }> = [
  { id: 'frontend', markers: ['ui', 'css', 'layout', 'visual', 'frontend', 'component'] },
  { id: 'database', markers: ['schema', 'sql', 'database', 'migration'] },
  { id: 'devops', markers: ['deploy', 'ci', 'infra', 'kubernetes', 'docker'] },
  { id: 'backend', markers: ['api', 'backend', 'server', 'endpoint'] },
];

const TASK_MARKERS: Array<{ id: string; markers: string[] }> = [
  { id: 'debug', markers: ['bug', 'debug', 'fix', 'failure', 'incident'] },
  { id: 'plan', markers: ['plan', 'architect', 'design', 'compare', 'evaluate'] },
  { id: 'test', markers: ['test', 'coverage', 'spec'] },
  { id: 'implement', markers: ['implement', 'write', 'add', 'change'] },
];

const MODIFIER_MARKERS: Array<{ id: string; markers: string[] }> = [
  { id: 'visual-heavy', markers: ['visual', 'screenshot', 'css', 'layout'] },
  { id: 'bounded-edit', markers: ['typo', 'rename', 'comment', 'format'] },
  { id: 'product-question', markers: ['what is', 'explain', 'why'] },
];

function digestOf(instruction: string, context?: string): string {
  return createHash('sha256')
    .update(`${instruction || ''}\0${context || ''}`)
    .digest('hex')
    .slice(0, 16);
}

function lowerText(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, ' ').trim();
}

function firstMatch(
  text: string,
  groups: Array<{ id: string; markers: string[] }>,
  fallback: string
): string {
  for (const group of groups) {
    if (group.markers.some((marker) => text.includes(marker))) return group.id;
  }
  return fallback;
}

export function classifyRoutingTaxonomy(
  instruction: string,
  context?: string
): RoutingTaxonomyLabels {
  const text = lowerText(`${instruction} ${context || ''}`);
  return {
    domain: firstMatch(text, DOMAIN_MARKERS, 'general'),
    task: firstMatch(text, TASK_MARKERS, 'general'),
    modifier: firstMatch(text, MODIFIER_MARKERS, 'unspecified'),
  };
}

export function admitRoutingCompare(input: {
  optimizeFor?: string;
  explicit?: boolean;
  cognitive: CognitiveRouteDecision;
}): RoutingCompareAdmission {
  const mode = resolveRoutingOptimizeMode(input.optimizeFor);
  const fanout = loadCognitiveRoutingPalette().modes[mode].fanout;
  if (fanout === 'never') {
    return { run: false, reason: 'palette forbids comparison fan-out', mode, fanout };
  }
  if (input.explicit) {
    return { run: true, reason: 'operator requested an explicit comparison', mode, fanout };
  }
  if (fanout === 'explicit_only') {
    return {
      run: false,
      reason: 'cost mode requires an explicit comparison request',
      mode,
      fanout,
    };
  }
  if (fanout === 'explicit_or_uncertain') {
    const run = input.cognitive.uncertainty >= 34 && !input.cognitive.deterministic_eligible;
    return {
      run,
      reason: run
        ? 'balance mode admits comparison when uncertainty is high'
        : 'balance mode keeps a single backend for routine work',
      mode,
      fanout,
    };
  }
  const run = input.cognitive.tier === 'heavy_reasoning';
  return {
    run,
    reason: run
      ? 'intelligence mode admits comparison for heavy-reasoning turns'
      : 'intelligence mode keeps a single backend for lighter turns',
    mode,
    fanout,
  };
}

export function planRoutingCompare(options: RoutingCompareRunOptions): RoutingComparePlan {
  const optimizeFor = resolveRoutingOptimizeMode(options.optimizeFor);
  const cognitive = buildCognitiveRouteDecision({
    mission_id: options.missionId || 'MSN-ROUTING-COMPARE',
    title: options.instruction.slice(0, 120),
    description: options.context || options.instruction,
    prompt: options.instruction,
    optimize_for: optimizeFor,
  });
  return {
    instruction_digest: digestOf(options.instruction, options.context),
    optimize_for: optimizeFor,
    labels: classifyRoutingTaxonomy(options.instruction, options.context),
    cognitive,
    admission: admitRoutingCompare({
      optimizeFor,
      explicit: options.explicit === true,
      cognitive,
    }),
    live_env_required: BEST_OF_PROVIDERS_LIVE_ENV_VAR,
    live_env_set: process.env[BEST_OF_PROVIDERS_LIVE_ENV_VAR] === '1',
  };
}

function comparisonLogPath(override?: string): string {
  return override || pathResolver.shared(ROUTING_COMPARE_LOG_RELATIVE_PATH);
}

function persistComparisonRecord(filePath: string, record: Record<string, unknown>): void {
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  appendJsonLine(filePath, record);
}

export async function runRoutingCompare(
  options: RoutingCompareRunOptions
): Promise<RoutingCompareResult> {
  const plan = planRoutingCompare(options);
  const shouldExecute = options.live === true && plan.admission.run;
  if (!shouldExecute) {
    return { plan, executed: false };
  }
  const comparison = await runBestOfProviders({
    instruction: options.instruction,
    context: options.context,
    dataTier: options.dataTier || 'public',
    providers: options.providers,
    candidates: options.candidates,
    seams: options.seams,
  });
  persistComparisonRecord(comparisonLogPath(options.comparisonLogPath), {
    ts: new Date().toISOString(),
    instruction_digest: plan.instruction_digest,
    optimize_for: plan.optimize_for,
    labels: plan.labels,
    cognitive_tier: plan.cognitive.tier,
    winner: comparison.winner?.candidate_id ?? comparison.winner?.provider ?? null,
    winner_backend: comparison.winner?.provider ?? null,
    winner_model: comparison.winner?.model ?? null,
    participants: comparison.verdictRecord.participants,
    degraded: comparison.verdictRecord.degraded ?? null,
    approve: comparison.verdictRecord.verdict.approve,
  });
  return { plan, executed: true, comparison };
}

export function peekRoutingCompareLog(logPath?: string): Record<string, unknown>[] {
  return readJsonLines<Record<string, unknown>>(comparisonLogPath(logPath), {
    onMalformed: 'skip',
    map: (value, lineNumber) =>
      parseSafeJsonObjectValue(value, `routing-compare line ${lineNumber}`),
  });
}

export function peekLinkedProviderVerdicts(verdictLogPath?: string) {
  return peekBestOfProvidersVerdictLog(verdictLogPath);
}
