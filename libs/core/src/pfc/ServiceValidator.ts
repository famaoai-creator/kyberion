import { createRequire } from 'node:module';
import { validatePhysicalDependencies } from './PhysicalLayer.js';
import { loadServiceEndpointsCatalog } from '../../service-binding.js';
import { safeReadFile, safeExistsSync, safeExec } from '../../secure-io.js';
import { pathResolver } from '../../path-resolver.js';
import { secretGuard } from '../../secret-guard.js';

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

export interface ServiceAuthInspection {
  serviceId: string;
  presetPath?: string;
  authStrategy: string;
  valid: boolean;
  reason?: string;
  requiredSecrets: string[];
  foundSecrets: string[];
  missingSecrets: string[];
  cliFallbacks: string[];
  setupHint: string;
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
  const inspection = inspectServiceAuth(serviceId, presetPath);
  return inspection.valid
    ? { valid: true }
    : { valid: false, reason: inspection.reason };
}

export function inspectServiceAuth(serviceId: string, presetPath?: string): ServiceAuthInspection {
  const resolvedPresetPath = presetPath ? pathResolver.rootResolve(presetPath) : undefined;
  if (!resolvedPresetPath || !safeExistsSync(resolvedPresetPath)) {
    return {
      serviceId,
      presetPath,
      authStrategy: 'none',
      valid: true,
      requiredSecrets: [],
      foundSecrets: [],
      missingSecrets: [],
      cliFallbacks: [],
      setupHint: 'No preset found; this surface is host-managed or uses a non-service auth path.',
    };
  }

  try {
    const presetRaw = safeReadFile(resolvedPresetPath, { encoding: 'utf8' }) as string;
    const preset = JSON.parse(presetRaw);
    const strategy = (preset.auth_strategy || 'none').toLowerCase();
    const endpoint = loadServiceEndpointsCatalog().services[serviceId];
    const suffixes = endpoint?.credential_suffixes || {};
    const requiredSecretNames = unique(
      strategy === 'bearer'
        ? [
            ...(suffixes.accessToken || ['ACCESS_TOKEN', 'BOT_TOKEN', 'TOKEN']),
          ]
        : strategy === 'basic'
          ? [
              ...(suffixes.clientId || ['CLIENT_ID']),
              ...(suffixes.clientSecret || ['CLIENT_SECRET']),
              ...(suffixes.accessToken || ['ACCESS_TOKEN']),
            ]
          : [
              ...(suffixes.accessToken || []),
              ...(suffixes.appToken || []),
              ...(suffixes.refreshToken || []),
              ...(suffixes.clientId || []),
              ...(suffixes.clientSecret || []),
              ...(suffixes.redirectUri || []),
            ],
    ).map((suffix) => `${serviceId.toUpperCase()}_${suffix}`);
    const foundSecrets = requiredSecretNames.filter((envName) => Boolean(secretGuard.getSecret(envName)));
    const missingSecrets = requiredSecretNames.filter((envName) => !foundSecrets.includes(envName));
    const cliFallbacks = collectCliFallbacks(preset);

    if (strategy === 'none') {
      return {
        serviceId,
        presetPath: resolvedPresetPath,
        authStrategy: strategy,
        valid: true,
        requiredSecrets: [],
        foundSecrets: [],
        missingSecrets: [],
        cliFallbacks,
        setupHint: cliFallbacks.length > 0
          ? `No secrets needed; CLI fallback available: ${cliFallbacks.join(', ')}`
          : 'No secrets needed for this preset.',
      };
    }

    // 1. Secret-backed auth check
    if ((strategy === 'bearer' || strategy === 'basic') && foundSecrets.length > 0) {
      return {
        serviceId,
        presetPath: resolvedPresetPath,
        authStrategy: strategy,
        valid: true,
        requiredSecrets: requiredSecretNames,
        foundSecrets,
        missingSecrets,
        cliFallbacks,
        setupHint: `Ready. Detected secrets: ${foundSecrets.join(', ')}`,
      };
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
          return {
            serviceId,
            presetPath: resolvedPresetPath,
            authStrategy: strategy,
            valid: true,
            requiredSecrets: requiredSecretNames,
            foundSecrets,
            missingSecrets,
            cliFallbacks,
            setupHint: `CLI fallback available via ${bin}.`,
          };
        } catch (err) {}
      }
    }

    return { 
      serviceId,
      presetPath: resolvedPresetPath,
      authStrategy: strategy,
      valid: false,
      reason: `Missing credentials for strategy: ${strategy} and no valid CLI fallback found for service ${serviceId}`,
      requiredSecrets: requiredSecretNames,
      foundSecrets,
      missingSecrets,
      cliFallbacks,
      setupHint: requiredSecretNames.length > 0
        ? `Set one of: ${requiredSecretNames.join(', ')}`
        : 'Add a service preset with either bearer/basic credentials or a CLI fallback.',
    };
  } catch (err: any) {
    return {
      serviceId,
      presetPath: resolvedPresetPath,
      authStrategy: 'unknown',
      valid: false,
      reason: `Failed to validate auth for ${serviceId}: ${err.message}`,
      requiredSecrets: [],
      foundSecrets: [],
      missingSecrets: [],
      cliFallbacks: [],
      setupHint: 'Check the preset path and service endpoint catalog.',
    };
  }
}

function collectCliFallbacks(preset: any): string[] {
  const commands = new Set<string>();
  for (const op of Object.values(preset.operations || {})) {
    const alternatives = Array.isArray((op as any).alternatives) ? (op as any).alternatives : [{ ...(op as any), type: (op as any).type || 'api' }];
    for (const alt of alternatives) {
      if ((alt as any).type === 'cli' && (alt as any).command) {
        commands.add(String((alt as any).command));
      }
    }
  }
  return Array.from(commands).sort();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

// Legacy class export for compatibility if needed, but functions are preferred
export const ServiceValidator = {
  validate: validateService,
  validateAuth: validateServiceAuth
};
