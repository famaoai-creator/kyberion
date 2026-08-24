import { pathResolver, safeReadFile } from '@agent/core';
import { loadGateManifest } from './run_checks.js';

const WORKFLOW_SCOPE_REFS = {
  pr: '.github/workflows/pr-validation.yml',
  full: '.github/workflows/ci.yml',
  release: '.github/workflows/release.yml',
} as const;

function read(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

export function checkCiGateParity(): string[] {
  const failures: string[] = [];
  const manifest = loadGateManifest();
  for (const scope of Object.keys(WORKFLOW_SCOPE_REFS) as Array<keyof typeof WORKFLOW_SCOPE_REFS>) {
    if (!manifest.gates.some((gate) => gate.scope === scope)) {
      failures.push(`manifest has no ${scope} gate`);
    }
    const workflow = read(WORKFLOW_SCOPE_REFS[scope]);
    const command = `pnpm run check -- --scope ${scope}`;
    if (!workflow.includes(command)) {
      failures.push(`${WORKFLOW_SCOPE_REFS[scope]} is missing ${command}`);
    }
  }
  const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
  if (!packageJson.scripts?.check?.includes('scripts/run_checks.ts')) {
    failures.push('package.json check script must use scripts/run_checks.ts');
  }
  return failures;
}

export function main(): void {
  const failures = checkCiGateParity();
  if (failures.length > 0) {
    console.error('[check:ci-gate-parity] FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('[check:ci-gate-parity] OK');
}

if (process.argv[1]?.endsWith('check_ci_gate_parity.ts')) main();
