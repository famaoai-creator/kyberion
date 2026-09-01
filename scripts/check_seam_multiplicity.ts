/** DH-03: static/runtime catalog gate for seam declaration invariants. */
import { loadCoreSeamBindings } from './bindings.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export function checkSeamMultiplicity(): { findings: string[]; seamCount: number } {
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

  return { findings, seamCount: bindings.length };
}

export const runCheckSeamMultiplicity = defineScript({
  name: 'check:seam-multiplicity',
  flags: [],
  run(context) {
    const result = checkSeamMultiplicity();
    if (result.findings.length > 0) {
      context.print('[check:seam-multiplicity] FAILED');
      for (const finding of result.findings) context.print(`- ${finding}`);
      throw new ScriptExitError(1);
    }
    context.print(`[check:seam-multiplicity] OK (${result.seamCount} seams)`);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'check_seam_multiplicity.ts') ||
  isDirectScript(import.meta.url, 'check_seam_multiplicity.js')
)
  void runCheckSeamMultiplicity();
