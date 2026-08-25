import { loadJson, pathResolver, safeExecResult } from '@agent/core';

type Gate = {
  id: string;
  scope: 'pr' | 'full' | 'release';
  executable?: string;
  args?: string[];
  script?: string;
  owner: string;
  rationale: string;
};

type GateManifest = { version: number; gates: Gate[] };

const VALID_SCOPES = new Set<Gate['scope']>(['pr', 'full', 'release']);

function isValidScope(value: string | undefined): value is Gate['scope'] {
  return value !== undefined && VALID_SCOPES.has(value as Gate['scope']);
}

export function validateGateManifest(manifest: GateManifest, availableScripts?: Set<string>): void {
  if (!manifest || !Array.isArray(manifest.gates)) {
    throw new Error('ci gate manifest must contain a gates array');
  }
  const ids = new Set<string>();
  for (const gate of manifest.gates) {
    if (!gate.id || ids.has(gate.id)) {
      throw new Error(
        `ci gate manifest contains a duplicate or empty gate id: ${gate.id || '(empty)'}`
      );
    }
    if (!isValidScope(gate.scope)) {
      throw new Error(`ci gate ${gate.id} has an invalid scope: ${String(gate.scope)}`);
    }
    const hasExecutable = Boolean(gate.executable);
    const hasScript = Boolean(gate.script);
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
  const manifest = loadJson<GateManifest>(
    pathResolver.knowledge('product/governance/ci-gates.json')
  );
  const packageJson = loadJson<{ scripts?: Record<string, string> }>(
    pathResolver.rootResolve('package.json')
  );
  validateGateManifest(manifest, new Set(Object.keys(packageJson.scripts || {})));
  return manifest;
}

export function selectGates(manifest: GateManifest, scope: Gate['scope'], only?: string): Gate[] {
  validateGateManifest(manifest);
  if (!isValidScope(scope)) throw new Error(`unknown check scope: ${String(scope)}`);
  const scoped = manifest.gates.filter(
    (gate) => gate.scope === scope || (scope === 'full' && gate.scope === 'pr')
  );
  if (only) {
    const selected = scoped.filter((gate) => gate.id === only);
    if (selected.length === 0) {
      throw new Error(`gate ${only} is not registered for scope ${scope}`);
    }
    return selected;
  }
  return scoped;
}

export function main(argv = process.argv.slice(2)): number {
  const supportedFlags = new Set(['--scope', '--only', '--json']);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith('--')) continue;
    if (!supportedFlags.has(flag)) {
      const json = argv.includes('--json');
      const message = `unknown check option: ${flag}`;
      if (json)
        console.log(
          JSON.stringify({ scope: undefined, results: [], failed: 0, error: message }, null, 2)
        );
      else console.error(`[check] ERROR ${message}`);
      return 1;
    }
    if (
      (flag === '--scope' || flag === '--only') &&
      (!argv[index + 1] || argv[index + 1]!.startsWith('--'))
    ) {
      const json = argv.includes('--json');
      const message = `${flag} requires a value`;
      if (json)
        console.log(
          JSON.stringify({ scope: undefined, results: [], failed: 0, error: message }, null, 2)
        );
      else console.error(`[check] ERROR ${message}`);
      return 1;
    }
  }
  const scopeIndex = argv.indexOf('--scope');
  const scopeValue = scopeIndex >= 0 ? argv[scopeIndex + 1] : 'pr';
  const onlyIndex = argv.indexOf('--only');
  const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : undefined;
  const json = argv.includes('--json');
  const error = (message: string): number => {
    if (json)
      console.log(JSON.stringify({ scope: scopeValue, results: [], failed: 0, error }, null, 2));
    else console.error(`[check] ERROR ${message}`);
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
  const results = gates.map((gate) => {
    const result = gate.script
      ? safeExecResult('pnpm', ['run', gate.script], { cwd: pathResolver.rootDir() })
      : safeExecResult(gate.executable!, gate.args || [], { cwd: pathResolver.rootDir() });
    return {
      id: gate.id,
      owner: gate.owner,
      status: result.status === 0 ? 'passed' : 'failed',
      exitCode: result.status,
    };
  });
  const failed = results.filter((result) => result.status === 'failed');
  if (json) console.log(JSON.stringify({ scope, results, failed: failed.length }, null, 2));
  else {
    console.log(`[check] scope=${scope} gates=${results.length} failed=${failed.length}`);
    for (const result of results) console.log(`- ${result.status.toUpperCase()} ${result.id}`);
  }
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith('run_checks.ts')) process.exitCode = main();
