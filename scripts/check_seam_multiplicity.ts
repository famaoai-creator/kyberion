/** DH-03: static/runtime catalog gate for seam declaration invariants. */
import { loadCoreSeamBindings } from './bindings.js';

const bindings = loadCoreSeamBindings();
const findings: string[] = [];
const keys = new Set<string>();

for (const binding of bindings) {
  if (keys.has(binding.key)) findings.push(`duplicate seam key: ${binding.key}`);
  keys.add(binding.key);
  const providerIds = new Set<string>();
  for (const provider of binding.providers) {
    if (providerIds.has(provider.id)) {
      findings.push(`duplicate provider '${provider.id}' in seam '${binding.key}'`);
    }
    providerIds.add(provider.id);
  }
  if (binding.multiplicity === 'sole' && binding.providers.length > 1) {
    findings.push(`sole seam '${binding.key}' has ${binding.providers.length} providers`);
  }
}

if (findings.length > 0) {
  console.error('[check:seam-multiplicity] FAILED');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`[check:seam-multiplicity] OK (${bindings.length} seams)`);
}
