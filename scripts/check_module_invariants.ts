/** DH-06: major runtime modules must declare an attributed invariant. */
import { pathResolver } from '@agent/core/path-resolver';
import { listModuleInvariants } from '@agent/core/invariants';
import { readTextFile } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const required = [
  { module: 'op-preflight', source: 'libs/core/op-preflight.ts' },
  { module: 'seam', source: 'libs/core/seam.ts' },
  { module: 'lifecycle-hook-engine', source: 'libs/core/lifecycle-hook-engine.ts' },
  { module: 'reasoning-provider-registry', source: 'libs/core/reasoning-provider-registry.ts' },
];
export function checkModuleInvariants(): { registeredInvariants: number } {
  const entries = listModuleInvariants();
  const missing: string[] = [];
  const sourceMissing: string[] = [];

  for (const target of required) {
    const owned = entries.filter((entry) => entry.module === target.module);
    if (owned.length === 0) missing.push(target.module);
    const source = readTextFile(pathResolver.rootResolve(target.source));
    if (!source.includes('assertModuleInvariant')) sourceMissing.push(target.source);
    for (const entry of owned) {
      if (entry.enforcement === 'runtime' && !entry.check) {
        missing.push(`${target.module}:${entry.id} (runtime check missing)`);
      }
      if (
        entry.enforcement === 'documented' &&
        !entry.reason?.startsWith('No runtime invariant:')
      ) {
        missing.push(`${target.module}:${entry.id} (documented reason missing)`);
      }
    }
  }

  if (missing.length > 0 || sourceMissing.length > 0) {
    throw new Error(
      `[check:module-invariants] FAILED: missing=${missing.join(',') || 'none'} source_without_assert=${sourceMissing.join(',') || 'none'}`
    );
  }

  return { registeredInvariants: entries.length };
}

export const runCheckModuleInvariants = defineScript({
  name: 'check:module-invariants',
  flags: [],
  run(context) {
    let result: { registeredInvariants: number };
    try {
      result = checkModuleInvariants();
    } catch (error) {
      throw new ScriptExitError(1, error instanceof Error ? error.message : String(error));
    }
    context.print(
      `[check:module-invariants] OK (${result.registeredInvariants} registered invariants)`
    );
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'check_module_invariants.ts') ||
  isDirectScript(import.meta.url, 'check_module_invariants.js')
)
  void runCheckModuleInvariants();
