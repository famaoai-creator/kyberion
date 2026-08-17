/** DH-06: major runtime modules must declare an attributed invariant. */
import { pathResolver } from '../libs/core/path-resolver.js';
import { listModuleInvariants } from '../libs/core/invariants.js';
import { safeReadFile } from '../libs/core/secure-io.js';

const required = [
  { module: 'op-preflight', source: 'libs/core/op-preflight.ts' },
  { module: 'seam', source: 'libs/core/seam.ts' },
  { module: 'lifecycle-hook-engine', source: 'libs/core/lifecycle-hook-engine.ts' },
  { module: 'reasoning-provider-registry', source: 'libs/core/reasoning-provider-registry.ts' },
];
const entries = listModuleInvariants();
const missing: string[] = [];
const sourceMissing: string[] = [];

for (const target of required) {
  const owned = entries.filter((entry) => entry.module === target.module);
  if (owned.length === 0) missing.push(target.module);
  const source = String(
    safeReadFile(pathResolver.rootResolve(target.source), { encoding: 'utf8' })
  );
  if (!source.includes('assertModuleInvariant')) sourceMissing.push(target.source);
  for (const entry of owned) {
    if (entry.enforcement === 'runtime' && !entry.check) {
      missing.push(`${target.module}:${entry.id} (runtime check missing)`);
    }
    if (entry.enforcement === 'documented' && !entry.reason?.startsWith('No runtime invariant:')) {
      missing.push(`${target.module}:${entry.id} (documented reason missing)`);
    }
  }
}

if (missing.length > 0 || sourceMissing.length > 0) {
  throw new Error(
    `[check:module-invariants] FAILED: missing=${missing.join(',') || 'none'} source_without_assert=${sourceMissing.join(',') || 'none'}`
  );
}

console.log(`[check:module-invariants] OK (${entries.length} registered invariants)`);
