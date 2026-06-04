import { logger, loadServiceEndpointsCatalog, fetchWithVaultCache } from './index.js';
import { resolveServiceBinding } from './service-binding.js';
import { getServicePresetRecord } from './service-preset-registry.js';
import {
  loadConnectionWithFallback,
  mergeParamsWithConnection,
  isPlainObject,
  resolveRequestEnvelope,
} from './service-engine-helpers.js';
import {
  executeServicePresetAlternative,
} from './service-engine-execution.js';

export { executeMcp } from './service-engine-execution.js';

export interface ServicePresetCacheOptions {
  /** When set, the result is cached in the Data Vault for this many milliseconds. */
  cache_ttl_ms?: number;
  /** Project scope for the vault entry (defaults to _global). */
  project_id?: string;
  /** Data tier for vault storage (defaults to confidential). */
  tier?: 'personal' | 'confidential' | 'public';
}

export async function executeServicePreset(
  serviceId: string,
  action: string,
  params: any,
  auth: 'none' | 'secret-guard' = 'none',
  cacheOpts?: ServicePresetCacheOptions,
): Promise<any> {
  const endpoints = loadServiceEndpointsCatalog();
  const serviceConfig = endpoints.services[serviceId];
  if (!serviceConfig || !serviceConfig.preset_path) {
    throw new Error(`No preset path defined for service: ${serviceId}`);
  }

  const preset = getServicePresetRecord(serviceId, serviceConfig.preset_path);
  if (!preset) {
    throw new Error(`No service preset found for: ${serviceId}`);
  }
  const op = preset.operations[action];
  if (!op) throw new Error(`Operation "${action}" not found in presets for ${serviceId}`);

  const alternatives = op.alternatives || [{ ...op, type: op.type || 'api' }];
  const envelope = resolveRequestEnvelope(params);
  const connection = loadConnectionWithFallback(serviceId);
  const mergedParams = {
    ...mergeParamsWithConnection(
      {
        ...(serviceConfig && typeof serviceConfig === 'object' ? serviceConfig : {}),
        ...(connection && typeof connection === 'object' ? connection : {}),
      },
      isPlainObject(params) ? params : {},
    ),
    [`${serviceId}_connection`]: connection,
    ...envelope.templateVars,
  };
  
  // Auth resolution
  const binding = resolveServiceBinding(serviceId, auth);
  for (const alt of alternatives) {
    try {
      const resolved = await executeServicePresetAlternative({
        serviceId,
        action,
        alt,
        serviceConfig,
        preset,
        params,
        envelope,
        mergedParams,
        binding,
      });
      if (resolved) return resolved.result;
    } catch (err: any) {
      logger.error(`  [ENGINE] Alternative failed: ${err.message}`);
    }
  }
  throw new Error(`All service alternatives failed for ${serviceId}:${action}`);
}

/**
 * Vault-cached variant of executeServicePreset.
 * Wraps the call in fetchWithVaultCache so repeated identical requests
 * are served from active/shared/data-vault/ within the TTL window.
 */
export async function executeServicePresetCached(
  serviceId: string,
  action: string,
  params: any,
  auth: 'none' | 'secret-guard' = 'none',
  cacheOpts: Required<Pick<ServicePresetCacheOptions, 'cache_ttl_ms'>> & ServicePresetCacheOptions,
): Promise<{ result: any; fromCache: boolean }> {
  const { createHash } = await import('node:crypto');
  const cacheKey = `${action}:${createHash('sha256').update(JSON.stringify(params ?? {})).digest('hex').slice(0, 16)}`;
  const { data: result, fromCache } = await fetchWithVaultCache(
    serviceId,
    cacheKey,
    () => executeServicePreset(serviceId, action, params, auth),
    {
      ttlMs: cacheOpts.cache_ttl_ms,
      projectId: cacheOpts.project_id,
      tier: cacheOpts.tier ?? 'confidential',
    },
  );
  if (fromCache) logger.info(`[ENGINE:VAULT] cache hit for ${serviceId}:${action}`);
  return { result, fromCache };
}
