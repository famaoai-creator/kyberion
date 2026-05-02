import { createRequire } from 'node:module';
import { validatePhysicalDependencies } from './PhysicalLayer.js';
import { resolveServiceBinding } from '../../service-binding.js';
import { safeReadFile, safeExistsSync, safeExec } from '../../secure-io.js';
import { pathResolver } from '../../path-resolver.js';

const require = createRequire(import.meta.url);

export interface ServiceRequirements {
  serviceName: string;
  cliBins?: string[];
  sdkModules?: string[];
  authCheck?: () => Promise<boolean>;
}

export type Tier = 'L0_CLI' | 'L1_SDK' | 'L5_API';

export interface ServiceValidationResult {
  valid: boolean;
  failedTiers: Tier[];
  details: {
    cliMissing: string[];
    sdkMissing: string[];
  };
}

/**
 * Validates a service across its 3 Tiers (CLI, SDK, API).
 */
export async function validateService(req: ServiceRequirements): Promise<ServiceValidationResult> {
  const failedTiers: Tier[] = [];
  const details = {
    cliMissing: [] as string[],
    sdkMissing: [] as string[]
  };

  // 1. L0 (CLI Layer)
  if (req.cliBins && req.cliBins.length > 0) {
    const cliRes = validatePhysicalDependencies(req.cliBins);
    if (!cliRes.valid) {
      failedTiers.push('L0_CLI');
      details.cliMissing = cliRes.missing;
    }
  }

  // 2. L1 (SDK Layer)
  if (req.sdkModules && req.sdkModules.length > 0) {
    for (const mod of req.sdkModules) {
      if (!checkModule(mod)) {
        details.sdkMissing.push(mod);
      }
    }
    if (details.sdkMissing.length > 0) {
      failedTiers.push('L1_SDK');
    }
  }

  // 3. L5 (API/Auth Layer)
  if (req.authCheck) {
    try {
      const isAuthValid = await req.authCheck();
      if (!isAuthValid) {
        failedTiers.push('L5_API');
      }
    } catch (err) {
      failedTiers.push('L5_API');
    }
  }

  return {
    valid: failedTiers.length === 0,
    failedTiers,
    details
  };
}

function checkModule(moduleName: string): boolean {
  try {
    require.resolve(moduleName, { paths: [pathResolver.rootDir()] });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * High-level validation for services based on preset definitions.
 * Checks both API tokens in Vault and CLI-based authentication health.
 */
export async function validateServiceAuth(serviceId: string, presetPath?: string): Promise<{ valid: boolean; reason?: string }> {
  const resolvedPresetPath = presetPath ? pathResolver.rootResolve(presetPath) : undefined;
  if (!resolvedPresetPath || !safeExistsSync(resolvedPresetPath)) {
    return { valid: true };
  }

  try {
    const presetRaw = safeReadFile(resolvedPresetPath, { encoding: 'utf8' }) as string;
    const preset = JSON.parse(presetRaw);
    const strategy = (preset.auth_strategy || 'none').toLowerCase();

    if (strategy === 'none') {
      return { valid: true };
    }

    // 1. API Auth check via Vault
    try {
      const binding = resolveServiceBinding(serviceId, 'secret-guard');
      if (strategy === 'bearer' && binding.accessToken) return { valid: true };
      if (strategy === 'basic' && (binding.accessToken || (binding.clientId && binding.clientSecret))) return { valid: true };
    } catch (err) {
      // API auth missing, continue to CLI fallback
    }

    // 2. CLI Auth fallback check via health_check commands
    const alternatives = (preset.alternatives || []).filter((a: any) => a.type === 'cli');
    for (const alt of alternatives) {
      if (alt.health_check) {
        try {
          const parts = alt.health_check.trim().split(/\s+/);
          const bin = parts[0];
          const args = parts.slice(1);
          safeExec(bin, args);
          return { valid: true }; 
        } catch (err) {}
      }
    }

    return { 
      valid: false, 
      reason: `Missing credentials for strategy: ${strategy} and no valid CLI fallback found for service ${serviceId}` 
    };
  } catch (err: any) {
    return { valid: false, reason: `Failed to validate auth for ${serviceId}: ${err.message}` };
  }
}

// Legacy class export for compatibility if needed, but functions are preferred
export const ServiceValidator = {
  validate: validateService,
  validateAuth: validateServiceAuth
};
