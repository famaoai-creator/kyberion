import { listReasoningProviderDescriptors } from '@agent/core/reasoning-provider-registry';
import { loadReasoningBackendPolicy } from '@agent/core/reasoning-backend-policy';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';

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

if (new Set(duplicateProviders).size > 0) {
  // Multiple modes may intentionally share one provider binary (for example
  // Claude CLI and Claude Agent); this is informational, not a failure.
  const shared = [...new Set(duplicateProviders)].sort().join(', ');
  console.warn(`[check:reasoning-provider-registry] shared providers: ${shared}`);
}

console.log(
  `[check:reasoning-provider-registry] OK (${descriptors.length} modes, ${new Set(descriptors.map((entry) => entry.provider)).size} providers)`
);
