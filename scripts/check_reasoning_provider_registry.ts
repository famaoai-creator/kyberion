import { listReasoningProviderDescriptors } from '@agent/core/reasoning-provider-registry';
import { loadReasoningBackendPolicy } from '@agent/core/reasoning-backend-policy';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export function checkReasoningProviderRegistry(): {
  modes: number;
  providers: number;
  sharedProviders: string[];
} {
  const descriptors = listReasoningProviderDescriptors();
  const policy = loadReasoningBackendPolicy();
  const descriptorModes = new Set(descriptors.map((entry) => entry.mode));
  const policyModes = new Set(policy.allowed_modes);
  const missing = [...policyModes].filter((mode) => !descriptorModes.has(mode));
  const orphaned = [...descriptorModes].filter((mode) => !policyModes.has(mode));
  const duplicateProviders = descriptors
    .map((entry) => entry.provider)
    .filter((provider, index, all) => all.indexOf(provider) !== index);
  const missingModules = descriptors
    .filter((descriptor) => {
      const logical = pathResolver.rootResolve(
        `libs/core/${descriptor.module.replace(/^\.\//u, '')}`
      );
      return ![logical, `${logical}.ts`, `${logical}.js`].some((candidate) =>
        safeExistsSync(candidate)
      );
    })
    .map((descriptor) => `${descriptor.mode}:${descriptor.module}`);

  if (missing.length > 0 || orphaned.length > 0 || missingModules.length > 0) {
    throw new Error(
      `[check:reasoning-provider-registry] policy/registry mismatch: missing=${missing.join(',') || 'none'} orphaned=${orphaned.join(',') || 'none'} missing_modules=${missingModules.join(',') || 'none'}`
    );
  }

  return {
    modes: descriptors.length,
    providers: new Set(descriptors.map((entry) => entry.provider)).size,
    sharedProviders: [...new Set(duplicateProviders)].sort(),
  };
}

export const runCheckReasoningProviderRegistry = defineScript({
  name: 'check:reasoning-provider-registry',
  flags: [],
  run(context) {
    let result: ReturnType<typeof checkReasoningProviderRegistry>;
    try {
      result = checkReasoningProviderRegistry();
    } catch (error) {
      throw new ScriptExitError(1, error instanceof Error ? error.message : String(error));
    }
    if (result.sharedProviders.length > 0) {
      context.print(
        `[check:reasoning-provider-registry] shared providers: ${result.sharedProviders.join(', ')}`
      );
    }
    context.print(
      `[check:reasoning-provider-registry] OK (${result.modes} modes, ${result.providers} providers)`
    );
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'check_reasoning_provider_registry.ts') ||
  isDirectScript(import.meta.url, 'check_reasoning_provider_registry.js')
)
  void runCheckReasoningProviderRegistry();
