/**
 * Plan or run a read-only comparison of one instruction across eligible
 * reasoning providers. Default is a dry plan. Live fan-out requires
 * `--live` and KYBERION_BEST_OF_PROVIDERS_LIVE=1.
 */
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { runRoutingCompare, type BestOfProviderCandidate } from '@agent/core';
import { resolveRoutingOptimizeMode } from '@agent/core';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { parseSafeJsonInput } from '@agent/core/foundation/safe-json';

const HELP = `Usage:
  pnpm reasoning:compare --instruction "<text>" [--optimize-for cost|balance|intelligence]
  pnpm reasoning:compare --instruction "<text>" --explicit [--live] [--json]
  pnpm reasoning:compare --instruction "<text>" --candidates \\
    '[{"backend":"claude","model":"opus","effort":"medium"},{"backend":"cursor","model":"auto"}]'

Default is a dry plan (no provider CLIs). --live fans the instruction out
to eligible providers and judges the results. Live mode also requires
KYBERION_BEST_OF_PROVIDERS_LIVE=1. Local pads only create a proposal;
this CLI is the execution surface.
`;

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseComparisonCandidates(raw?: string): BestOfProviderCandidate[] | undefined {
  if (!raw?.trim()) return undefined;
  const parsed = parseSafeJsonInput(raw, 'reasoning compare candidates');
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('--candidates must be a non-empty JSON array');
  }
  return parsed.map((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`--candidates[${index}] must be an object`);
    }
    const item = value as Record<string, unknown>;
    const unknown = Object.keys(item).find(
      (key) => !['backend', 'provider', 'model', 'effort'].includes(key)
    );
    if (unknown) throw new Error(`--candidates[${index}] contains unknown field ${unknown}`);
    const provider = String(item.backend || item.provider || '').trim();
    const model = String(item.model || '').trim();
    const effort = item.effort;
    if (!provider) throw new Error(`--candidates[${index}] requires backend`);
    if (effort !== undefined && effort !== 'low' && effort !== 'medium' && effort !== 'high') {
      throw new Error(`--candidates[${index}].effort must be low, medium, or high`);
    }
    return {
      provider,
      ...(model ? { model } : {}),
      ...(effort ? { effort: effort as 'low' | 'medium' | 'high' } : {}),
    };
  });
}

export async function main(
  argv: string[] = [],
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  if (argv.length === 0 || hasFlag(argv, '--help') || argv[0] === 'help') {
    print(HELP);
    return;
  }
  const instruction = option(argv, '--instruction')?.trim();
  if (!instruction) {
    throw new ScriptExitError(2, 'missing --instruction', true);
  }
  const live = hasFlag(argv, '--live');
  if (live && getRegisteredEnvText('KYBERION_BEST_OF_PROVIDERS_LIVE') !== '1') {
    throw new ScriptExitError(
      2,
      'live comparison requires KYBERION_BEST_OF_PROVIDERS_LIVE=1',
      true
    );
  }
  const result = await runRoutingCompare({
    instruction,
    context: option(argv, '--context'),
    optimizeFor: resolveRoutingOptimizeMode(option(argv, '--optimize-for') || undefined),
    explicit: hasFlag(argv, '--explicit') || live,
    live,
    providers: option(argv, '--providers')
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    candidates: parseComparisonCandidates(option(argv, '--candidates')),
  });
  print(result);
  if (live && !result.executed) {
    throw new ScriptExitError(1, result.plan.admission.reason, true);
  }
}

export const runReasoningCompare = defineScript({
  name: 'reasoning:compare',
  // `--live` / `--explicit` are script-owned and read from argv in main().
  flags: ['json', 'quiet'],
  run: async ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'reasoning_compare.ts') ||
  isDirectScript(import.meta.url, 'reasoning_compare.js')
)
  void runReasoningCompare();
