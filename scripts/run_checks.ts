import { pathResolver, safeExecResult, safeReadFile } from '@agent/core';

type Gate = {
  id: string;
  scope: 'pr' | 'full' | 'release';
  executable: string;
  args: string[];
  owner: string;
  rationale: string;
};

type GateManifest = { version: number; gates: Gate[] };

export function loadGateManifest(): GateManifest {
  return JSON.parse(
    String(
      safeReadFile(pathResolver.knowledge('product/governance/ci-gates.json'), { encoding: 'utf8' })
    )
  ) as GateManifest;
}

export function selectGates(manifest: GateManifest, scope: Gate['scope'], only?: string): Gate[] {
  return manifest.gates.filter((gate) =>
    only ? gate.id === only : gate.scope === scope || (scope === 'full' && gate.scope === 'pr')
  );
}

export function main(argv = process.argv.slice(2)): number {
  const scopeIndex = argv.indexOf('--scope');
  const scope = (scopeIndex >= 0 ? argv[scopeIndex + 1] : 'pr') as Gate['scope'];
  const onlyIndex = argv.indexOf('--only');
  const only = onlyIndex >= 0 ? argv[onlyIndex + 1] : undefined;
  const json = argv.includes('--json');
  const gates = selectGates(loadGateManifest(), scope, only);
  const results = gates.map((gate) => {
    const result = safeExecResult(gate.executable, gate.args, { cwd: pathResolver.rootDir() });
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
