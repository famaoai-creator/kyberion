import { pathResolver, safeReadFile } from '@agent/core';
import { loadGateManifest } from './run_checks.js';
import { defineScript, isDirectScript } from './lib/harness.js';

const WORKFLOW_SCOPE_REFS = {
  pr: '.github/workflows/pr-validation.yml',
  full: '.github/workflows/ci.yml',
  release: '.github/workflows/release.yml',
} as const;
const WORKFLOW_PATHS = [...Object.values(WORKFLOW_SCOPE_REFS), '.github/workflows/cross-os.yml'];

function read(relativePath: string): string {
  return String(safeReadFile(pathResolver.rootResolve(relativePath), { encoding: 'utf8' }));
}

export function collectPnpmScriptReferences(value: string): string[] {
  const refs = new Set<string>();
  for (const match of value.matchAll(/\bpnpm\s+run\s+([A-Za-z0-9][A-Za-z0-9:_-]*)\b/gu)) {
    refs.add(match[1]!);
  }
  return [...refs];
}

export function checkCiGateParity(): string[] {
  const failures: string[] = [];
  const manifest = loadGateManifest();
  const packageJson = JSON.parse(read('package.json')) as { scripts?: Record<string, string> };
  const declaredGates = new Set(
    manifest.gates.flatMap((gate) => [gate.id, ...(gate.script ? [gate.script] : [])])
  );
  const exceptions = (manifest.workflow_exceptions || []) as Array<{
    workflow: string;
    script: string;
    reason: string;
  }>;
  const exceptionKeys = new Set(exceptions.map((entry) => `${entry.workflow}:${entry.script}`));
  for (const entry of exceptions) {
    if (!WORKFLOW_PATHS.includes(entry.workflow)) {
      failures.push(`workflow exception references unknown workflow: ${entry.workflow}`);
    }
    if (!packageJson.scripts?.[entry.script]) {
      failures.push(`workflow exception references unknown package script: ${entry.script}`);
    }
  }
  for (const gate of manifest.gates) {
    const command = [gate.executable, ...(gate.args || [])].filter(Boolean).join(' ');
    for (const script of collectPnpmScriptReferences(command)) {
      if (!packageJson.scripts?.[script]) {
        failures.push(`ci-gates.json gate ${gate.id} references unknown package script ${script}`);
      }
    }
  }
  for (const workflowPath of WORKFLOW_PATHS) {
    const workflow = read(workflowPath);
    const scripts = [...workflow.matchAll(/\bpnpm\s+run\s+(check:[A-Za-z0-9_-]+)/g)].map(
      (match) => match[1]!
    );
    for (const script of new Set(scripts)) {
      if (!packageJson.scripts?.[script]) {
        failures.push(`${workflowPath} references unknown package script ${script}`);
      } else if (
        !declaredGates.has(script) &&
        !declaredGates.has(script.replace(/^check:/u, '')) &&
        !exceptionKeys.has(`${workflowPath}:${script}`)
      ) {
        failures.push(
          `${workflowPath} check script ${script} is not in ci-gates or workflow_exceptions`
        );
      }
    }
  }
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
  if (!packageJson.scripts?.check?.includes('scripts/run_checks.ts')) {
    failures.push('package.json check script must use scripts/run_checks.ts');
  }
  return failures;
}

export const runCheckCiGateParity = defineScript({
  name: 'check:ci-gate-parity',
  run(context) {
    const failures = checkCiGateParity();
    if (failures.length > 0) {
      throw new Error(failures.join('; '));
    }
    context.print('[check:ci-gate-parity] OK');
  },
});

if (
  isDirectScript(import.meta.url, 'check_ci_gate_parity.ts') ||
  isDirectScript(import.meta.url, 'check_ci_gate_parity.js')
)
  void runCheckCiGateParity();
