import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult, safeExecResultAsync } from '@agent/core/secure-io';
import { defineCatalog } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';
import { readSafeJsonFile } from './lib/json-input.js';
import {
  describeChangedGateMatch,
  selectChangedGates,
  validateGatePaths,
  type ChangedGateMatch,
} from './lib/changed-gate-selection.js';

type Gate = {
  id: string;
  scope: 'pr' | 'full' | 'release';
  executable?: string;
  args?: string[];
  script?: string;
  timeout_ms?: number;
  baseline?: string;
  /** full/release only: repo-relative globs whose change selects this gate under `--changed`. */
  paths?: string[];
  owner: string;
  rationale: string;
};

type GateManifest = {
  version: number;
  gates: Gate[];
  workflow_exceptions?: Array<{ workflow: string; script: string; reason: string }>;
};

const gateManifestCatalog = defineCatalog<GateManifest>({
  id: 'ci-gates',
  path: () => pathResolver.knowledge('product/governance/ci-gates.json'),
  schema: 'knowledge/product/schemas/ci-gates.schema.json',
});

const VALID_SCOPES = new Set<Gate['scope']>(['pr', 'full', 'release']);

/**
 * Selection scopes for `--scope`. A gate declares pr, full or release;
 * `full-only` selects the full gates without the pr gates, so a CI job that
 * runs alongside pr-validation.yml (`--scope pr`) covers `full` without
 * running every pr gate twice: pr ∪ full-only = full.
 */
export type CheckScope = Gate['scope'] | 'full-only';
const CHECK_SCOPES = new Set<CheckScope>([...VALID_SCOPES, 'full-only']);
export const DEFAULT_GATE_TIMEOUT_MS = 120_000;
export const DEFAULT_CONCURRENT_GATES = 6;

/** A scheduling bound only: never changes gate selection or pass/fail semantics. */
export function parseCheckJobs(value: string | undefined, flag = '--jobs'): number {
  if (value === undefined) return DEFAULT_CONCURRENT_GATES;
  if (!/^[1-6]$/.test(value)) {
    throw new Error(`${flag} must be an integer from 1 to 6`);
  }
  return Number(value);
}

// `pnpm run` and `pnpm exec` may reconcile the workspace node_modules tree
// before starting a command. Keep package-manager-backed gates on one lane so
// a recovery install cannot race another gate and delete its dependency links.
let packageManagerGateTail: Promise<void> = Promise.resolve();

function usesPackageManager(gate: Gate): boolean {
  if (gate.script || gate.executable === 'pnpm') return true;
  // The contrast gate starts a package-manager-backed Next server as a child.
  return gate.args?.some((arg) => arg.endsWith('check_chronos_dom_contrast.ts')) ?? false;
}

async function withPackageManagerGateLock<T>(operation: () => Promise<T>): Promise<T> {
  const previous = packageManagerGateTail;
  let release!: () => void;
  packageManagerGateTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

function isValidScope(value: string | undefined): value is Gate['scope'] {
  return value !== undefined && VALID_SCOPES.has(value as Gate['scope']);
}

function isCheckScope(value: string | undefined): value is CheckScope {
  return value !== undefined && CHECK_SCOPES.has(value as CheckScope);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function validateGateManifest(manifest: GateManifest, availableScripts?: Set<string>): void {
  if (!isRecord(manifest) || !Array.isArray(manifest.gates)) {
    throw new Error('ci gate manifest must contain a gates array');
  }
  if (manifest.version !== 1) {
    throw new Error(`ci gate manifest version must be 1: ${String(manifest.version)}`);
  }
  const ids = new Set<string>();
  for (const candidate of manifest.gates) {
    if (!isRecord(candidate)) {
      throw new Error('ci gate manifest entries must be objects');
    }
    const gate = candidate as unknown as Gate;
    if (typeof gate.id !== 'string' || !gate.id.trim() || ids.has(gate.id)) {
      throw new Error(
        `ci gate manifest contains a duplicate or empty gate id: ${gate.id || '(empty)'}`
      );
    }
    if (typeof gate.scope !== 'string' || !isValidScope(gate.scope)) {
      throw new Error(`ci gate ${gate.id} has an invalid scope: ${String(gate.scope)}`);
    }
    if (typeof gate.owner !== 'string' || !gate.owner.trim()) {
      throw new Error(`ci gate ${gate.id} must declare a non-empty owner`);
    }
    if (typeof gate.rationale !== 'string' || !gate.rationale.trim()) {
      throw new Error(`ci gate ${gate.id} must declare a non-empty rationale`);
    }
    if (
      gate.args !== undefined &&
      (!Array.isArray(gate.args) || gate.args.some((arg) => typeof arg !== 'string'))
    ) {
      throw new Error(`ci gate ${gate.id} args must be an array of strings`);
    }
    if (
      gate.timeout_ms !== undefined &&
      (!Number.isSafeInteger(gate.timeout_ms) || gate.timeout_ms <= 0)
    ) {
      throw new Error(`ci gate ${gate.id} timeout_ms must be a positive integer`);
    }
    const pathErrors = validateGatePaths(gate);
    if (pathErrors.length > 0) throw new Error(pathErrors.join('; '));
    const hasExecutable = typeof gate.executable === 'string' && gate.executable.trim().length > 0;
    const hasScript = typeof gate.script === 'string' && gate.script.trim().length > 0;
    if (hasExecutable === hasScript) {
      throw new Error(`ci gate ${gate.id} must declare exactly one of executable or script`);
    }
    if (hasExecutable) {
      if (!Array.isArray(gate.args)) {
        throw new Error(`ci gate ${gate.id} executable gates must declare args`);
      }
      const command = [gate.executable, ...gate.args].join(' ');
      if (/run_checks|pnpm\s+(run\s+)?(check|validate)|run_pipeline/.test(command)) {
        throw new Error(
          `ci gate ${gate.id} may not recursively invoke a check or validate entrypoint`
        );
      }
    } else if (gate.script === 'check' || gate.script === 'validate') {
      throw new Error(`ci gate ${gate.id} may not invoke the check or validate script itself`);
    } else if (availableScripts && !availableScripts.has(gate.script!)) {
      throw new Error(`ci gate ${gate.id} references an unknown package script: ${gate.script}`);
    }
    ids.add(gate.id);
  }
}

export function loadGateManifest(): GateManifest {
  const manifest = gateManifestCatalog.load();
  const packageJson = readSafeJsonFile<{ scripts?: Record<string, string> }>(
    pathResolver.rootResolve('package.json'),
    'package manifest for check runner'
  );
  validateGateManifest(manifest, new Set(Object.keys(packageJson.scripts || {})));
  return manifest;
}

export function selectGates(manifest: GateManifest, scope: CheckScope, only?: string): Gate[] {
  validateGateManifest(manifest);
  if (!isCheckScope(scope)) throw new Error(`unknown check scope: ${String(scope)}`);
  const scoped = manifest.gates.filter((gate) => {
    if (scope === 'release') return true;
    if (scope === 'full-only') return gate.scope === 'full';
    return gate.scope === scope || (scope === 'full' && gate.scope === 'pr');
  });
  if (only) {
    const ids = only
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    const selected = scoped.filter(
      (gate) => ids.includes(gate.id) && (scope !== 'release' || gate.scope === 'release')
    );
    const missing = ids.filter((id) => !selected.some((gate) => gate.id === id));
    if (missing.length > 0) {
      throw new Error(`gate(s) ${missing.join(',')} are not registered for scope ${scope}`);
    }
    return selected;
  }
  return scoped;
}

/** Default `--changed` bases, tried in order when `--base` is omitted. */
export const DEFAULT_CHANGED_BASES = ['origin/main', 'main'] as const;
const GIT_REF_PATTERN = /^[A-Za-z0-9._/@^~-]+$/u;

export type GitRunner = (args: string[]) => {
  status: number | null;
  stdout: string;
  stderr: string;
};

const runGit: GitRunner = (args) =>
  safeExecResult('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: pathResolver.rootDir(),
    timeoutMs: 60_000,
  });

export interface ChangedFiles {
  base: string;
  mergeBase: string;
  files: string[];
}

/**
 * Files that differ from the merge-base with `base`: committed, staged and
 * unstaged changes (`git diff <merge-base>` compares the working tree) plus
 * untracked, non-ignored files. Renames count on both sides so a moved input
 * still selects the gate that read it.
 */
export function collectChangedFiles(base?: string, git: GitRunner = runGit): ChangedFiles {
  const candidates = base ? [base] : [...DEFAULT_CHANGED_BASES];
  for (const candidate of candidates) {
    if (!GIT_REF_PATTERN.test(candidate) || candidate.startsWith('-')) {
      throw new Error(`--base must be a git ref name: ${candidate}`);
    }
  }
  let resolved: { base: string; mergeBase: string } | undefined;
  for (const candidate of candidates) {
    const result = git(['merge-base', 'HEAD', candidate]);
    const mergeBase = result.stdout.trim();
    if (result.status === 0 && mergeBase) {
      resolved = { base: candidate, mergeBase };
      break;
    }
  }
  if (!resolved) {
    throw new Error(
      `could not resolve a merge-base with ${candidates.join(' or ')} — run \`git fetch origin main\` or pass --base <ref>`
    );
  }
  const diff = git(['diff', '--name-only', '--no-renames', resolved.mergeBase, '--']);
  if (diff.status !== 0) {
    throw new Error(`git diff against ${resolved.mergeBase} failed: ${diff.stderr.trim()}`);
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard']);
  if (untracked.status !== 0) {
    throw new Error(`git ls-files failed: ${untracked.stderr.trim()}`);
  }
  const files = [
    ...new Set(
      `${diff.stdout}\n${untracked.stdout}`
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  ].sort();
  return { ...resolved, files };
}

/**
 * Execute one declared gate through secure-io. Hosted browser coverage needs
 * this non-secret CI marker, which is intentionally absent from the global
 * inherited-environment allowlist. Forward only its canonical true value and
 * only to the existing Operator boundary gate.
 */
export async function executeCheckGate(gate: Gate) {
  const env =
    gate.id === 'mos-no-write-api' && process.env.GITHUB_ACTIONS === 'true'
      ? { GITHUB_ACTIONS: 'true' }
      : undefined;
  const options = {
    cwd: pathResolver.rootDir(),
    timeoutMs: gate.timeout_ms ?? DEFAULT_GATE_TIMEOUT_MS,
    ...(env ? { env } : {}),
  };
  return gate.script
    ? safeExecResultAsync('pnpm', ['run', gate.script], options)
    : safeExecResultAsync(gate.executable!, gate.args || [], options);
}

export async function main(
  argv: string[] = [],
  print: (value: unknown) => void = () => undefined
): Promise<number> {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const supportedFlags = new Set(['--scope', '--only', '--json', '--jobs', '--changed', '--base']);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith('--')) continue;
    if (!supportedFlags.has(flag)) {
      const json = args.includes('--json');
      const message = `unknown check option: ${flag}`;
      if (json) print({ scope: undefined, results: [], failed: 0, error: message });
      else print(`[check] ERROR ${message}`);
      return 1;
    }
    if (
      (flag === '--scope' || flag === '--only' || flag === '--jobs' || flag === '--base') &&
      (!args[index + 1] || args[index + 1]!.startsWith('--'))
    ) {
      const json = args.includes('--json');
      const message = `${flag} requires a value`;
      if (json) print({ scope: undefined, results: [], failed: 0, error: message });
      else print(`[check] ERROR ${message}`);
      return 1;
    }
  }
  const scopeIndex = args.indexOf('--scope');
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
  // A named gate (`--only tenant-registry`) is found in pr and full gates alike;
  // only a bare run defaults to the pr set.
  const scopeValue = scopeIndex >= 0 ? args[scopeIndex + 1] : only ? 'full' : 'pr';
  const json = args.includes('--json');
  const error = (message: string): number => {
    if (json) print({ scope: scopeValue, results: [], failed: 0, error: message });
    else print(`[check] ERROR ${message}`);
    return 1;
  };
  if (!isCheckScope(scopeValue)) return error(`unknown check scope: ${String(scopeValue)}`);
  if (scopeIndex >= 0 && !scopeValue) return error('--scope requires a value');
  if (onlyIndex >= 0 && !only) return error('--only requires a gate id');
  if (args.filter((arg) => arg === '--jobs').length > 1)
    return error('--jobs may only be specified once');
  const jobsIndex = args.indexOf('--jobs');
  let jobs: number;
  try {
    jobs = parseCheckJobs(jobsIndex >= 0 ? args[jobsIndex + 1] : undefined);
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : String(cause));
  }
  const changedMode = args.includes('--changed');
  const baseIndex = args.indexOf('--base');
  if (baseIndex >= 0 && !changedMode) return error('--base requires --changed');
  if (changedMode && (scopeIndex >= 0 || onlyIndex >= 0)) {
    return error('--changed selects gates itself; do not combine it with --scope or --only');
  }
  const scope = changedMode ? 'changed' : scopeValue;
  let gates: Gate[];
  let changed: (ChangedFiles & { extra: ChangedGateMatch[] }) | undefined;
  try {
    if (changedMode) {
      const changedFiles = collectChangedFiles(baseIndex >= 0 ? args[baseIndex + 1] : undefined);
      const selection = selectChangedGates(loadGateManifest().gates, changedFiles.files);
      gates = selection.gates;
      changed = { ...changedFiles, extra: selection.extra };
    } else {
      gates = selectGates(loadGateManifest(), scopeValue, only);
    }
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : String(cause));
  }
  if (gates.length === 0) return error(`no gates registered for scope ${scope}`);
  if (changed && !json) {
    print(
      `[check] --changed: ${changed.files.length} file(s) vs ${changed.base} (merge-base ${changed.mergeBase.slice(0, 12)}); pr gates + ${changed.extra.length} path-selected gate(s)`
    );
    for (const match of changed.extra) print(describeChangedGateMatch(match));
  }
  const results: Array<{
    id: string;
    owner: string;
    status: 'passed' | 'failed';
    exitCode: number | null;
    stderr?: string;
    stdout?: string;
    error?: string;
  }> = new Array(gates.length);
  let nextGateIndex = 0;
  const runGate = async (gate: Gate): Promise<(typeof results)[number]> => {
    const execute = () => executeCheckGate(gate);
    const result = usesPackageManager(gate)
      ? await withPackageManagerGateLock(execute)
      : await execute();
    return {
      id: gate.id,
      owner: gate.owner,
      status: result.status === 0 ? 'passed' : 'failed',
      exitCode: result.status,
      ...(result.status !== 0
        ? {
            stderr: result.stderr.trim().slice(-2000),
            stdout: result.stdout.trim().slice(-2000),
            error: result.error?.message,
          }
        : {}),
    };
  };
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextGateIndex++;
      if (index >= gates.length) return;
      results[index] = await runGate(gates[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, gates.length) }, () => worker()));
  const failed = results.filter((result) => result.status === 'failed');
  if (json)
    print({
      scope,
      results,
      failed: failed.length,
      ...(changed
        ? {
            changed: {
              base: changed.base,
              merge_base: changed.mergeBase,
              files: changed.files,
              selected: changed.extra,
            },
          }
        : {}),
    });
  else {
    print(`[check] scope=${scope} gates=${results.length} failed=${failed.length}`);
    for (const result of results) {
      print(`- ${result.status.toUpperCase()} ${result.id}`);
      if (result.status === 'failed') {
        if (result.stderr) print(`  stderr: ${result.stderr}`);
        if (result.stdout) print(`  stdout: ${result.stdout}`);
        if (result.error) print(`  error: ${result.error}`);
      }
    }
  }
  return failed.length === 0 ? 0 : 1;
}

export const runChecks = defineScript({
  name: 'check',
  flags: ['json', 'quiet'],
  async run(context) {
    const status = await main(context.argv, context.print);
    if (status !== 0) throw new Error(`check command failed with exit code ${status}`);
  },
});

if (
  isDirectScript(import.meta.url, 'run_checks.ts') ||
  isDirectScript(import.meta.url, 'run_checks.js')
)
  void runChecks();
