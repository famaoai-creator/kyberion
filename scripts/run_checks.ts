import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResultAsync } from '@agent/core/secure-io';
import { defineCatalog } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';
import { readSafeJsonFile } from './lib/json-input.js';

type Gate = {
  id: string;
  scope: 'pr' | 'full' | 'release';
  executable?: string;
  args?: string[];
  script?: string;
  timeout_ms?: number;
  baseline?: string;
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
const DEFAULT_GATE_TIMEOUT_MS = 120_000;
const MAX_CONCURRENT_GATES = 6;

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

export function selectGates(manifest: GateManifest, scope: Gate['scope'], only?: string): Gate[] {
  validateGateManifest(manifest);
  if (!isValidScope(scope)) throw new Error(`unknown check scope: ${String(scope)}`);
  const scoped = manifest.gates.filter((gate) => {
    if (scope === 'release') return true;
    return gate.scope === scope || (scope === 'full' && gate.scope === 'pr');
  });
  if (only) {
    const selected = scoped.filter(
      (gate) => gate.id === only && (scope !== 'release' || gate.scope === 'release')
    );
    if (selected.length === 0) {
      throw new Error(`gate ${only} is not registered for scope ${scope}`);
    }
    return selected;
  }
  return scoped;
}

export async function main(
  argv: string[] = [],
  print: (value: unknown) => void = () => undefined
): Promise<number> {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const supportedFlags = new Set(['--scope', '--only', '--json']);
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
      (flag === '--scope' || flag === '--only') &&
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
  const scopeValue = scopeIndex >= 0 ? args[scopeIndex + 1] : 'pr';
  const onlyIndex = args.indexOf('--only');
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined;
  const json = args.includes('--json');
  const error = (message: string): number => {
    if (json) print({ scope: scopeValue, results: [], failed: 0, error: message });
    else print(`[check] ERROR ${message}`);
    return 1;
  };
  if (!isValidScope(scopeValue)) return error(`unknown check scope: ${String(scopeValue)}`);
  if (scopeIndex >= 0 && !scopeValue) return error('--scope requires a value');
  if (onlyIndex >= 0 && !only) return error('--only requires a gate id');
  const scope = scopeValue;
  let gates: Gate[];
  try {
    gates = selectGates(loadGateManifest(), scopeValue, only);
  } catch (cause) {
    return error(cause instanceof Error ? cause.message : String(cause));
  }
  if (gates.length === 0) return error(`no gates registered for scope ${scopeValue}`);
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
    const execute = async () =>
      gate.script
        ? await safeExecResultAsync('pnpm', ['run', gate.script], {
            cwd: pathResolver.rootDir(),
            timeoutMs: gate.timeout_ms ?? DEFAULT_GATE_TIMEOUT_MS,
          })
        : await safeExecResultAsync(gate.executable!, gate.args || [], {
            cwd: pathResolver.rootDir(),
            timeoutMs: gate.timeout_ms ?? DEFAULT_GATE_TIMEOUT_MS,
          });
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
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT_GATES, gates.length) }, () => worker())
  );
  const failed = results.filter((result) => result.status === 'failed');
  if (json) print({ scope, results, failed: failed.length });
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
