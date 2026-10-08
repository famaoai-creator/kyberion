import { createLogger } from '../logger.js';
import {
  consumeOperatorServiceProbeAdmission,
  OperatorServiceProbeError,
} from './operator-service-connection-admission.js';
import { SecureFetchError } from '../network.js';
import { loadServiceEndpointsCatalog } from './service-endpoint-registry.js';
import { fetchWithVaultCache } from '../data-vault.js';
import { resolveServiceBinding } from './service-binding.js';
import { getServicePresetRecord } from './service-preset-registry.js';
import {
  loadConnectionWithFallback,
  mergeParamsWithConnection,
  isPlainObject,
  resolveRequestEnvelope,
} from './service-engine-helpers.js';
import { executeServicePresetAlternative } from './service-engine-execution.js';
import { authorizeTenantServiceAction } from './service-binding-registry.js';
import { resolveTenantServiceEngineAdmission } from './service-engine-admission.js';

const logger = createLogger('service-engine');

export { executeMcp } from './service-engine-execution.js';

export interface ServicePresetCacheOptions {
  /** When set, the result is cached in the Data Vault for this many milliseconds. */
  cache_ttl_ms?: number;
  /** Project scope for the vault entry (defaults to _global). */
  project_id?: string;
  /** Data tier for vault storage (defaults to confidential). */
  tier?: 'personal' | 'confidential' | 'public';
}

function enforceTenantBindingContract(
  serviceId: string,
  action: string,
  preset: NonNullable<ReturnType<typeof getServicePresetRecord>>,
  tenantBindingCapability?: object
): void {
  const operation = preset.operations[action];
  if (!operation) throw new Error(`Operation "${action}" not found in presets for ${serviceId}`);
  const operationBindingRequired =
    preset.tenant_binding_required === true || operation.tenant_binding_required === true;
  if (!operationBindingRequired) return;
  if (!tenantBindingCapability) {
    throw new Error(
      `[POLICY_VIOLATION] ${serviceId}:${action} requires an admitted tenant service binding`
    );
  }
  const tenantBindingContext = resolveTenantServiceEngineAdmission(tenantBindingCapability);
  if (!tenantBindingContext) {
    throw new Error('[POLICY_VIOLATION] Invalid tenant service actuator admission capability');
  }
  const authorization = authorizeTenantServiceAction({
    serviceId,
    action,
    securityScope: tenantBindingContext.securityScope,
    bindingId: tenantBindingContext.bindingId,
  });
  const approvalRequired =
    authorization.approvalRequired ||
    operation.approval_required === true ||
    operation.risk === 'write' ||
    operation.risk === 'destructive' ||
    (operation.approval_required !== false && operation.risk !== 'read');
  if (approvalRequired && tenantBindingContext.approvalGranted !== true) {
    throw new Error(
      `[POLICY_VIOLATION] ${serviceId}:${action} requires an admitted approval decision`
    );
  }
}

export async function executeServicePreset(
  serviceId: string,
  action: string,
  params: any,
  auth: 'none' | 'secret-guard' = 'none',
  cacheOpts?: ServicePresetCacheOptions,
  tenantBindingCapability?: object,
  operatorProbeCapability?: object
): Promise<any> {
  const probe = operatorProbeCapability
    ? consumeOperatorServiceProbeAdmission(operatorProbeCapability, serviceId, action)
    : undefined;
  const serviceConfig = probe?.serviceConfig || loadServiceEndpointsCatalog().services[serviceId];
  if (!serviceConfig || !serviceConfig.preset_path) {
    throw new Error(`No preset path defined for service: ${serviceId}`);
  }

  const preset = probe?.preset || getServicePresetRecord(serviceId, serviceConfig.preset_path);
  if (!preset) {
    throw new Error(`No service preset found for: ${serviceId}`);
  }
  const op = preset.operations[action];
  if (!op) throw new Error(`Operation "${action}" not found in presets for ${serviceId}`);

  enforceTenantBindingContract(serviceId, action, preset, tenantBindingCapability);

  const alternatives = op.alternatives || [{ ...op, type: op.type || 'api' }];
  const envelope = resolveRequestEnvelope(params);
  // A probe must not load or template the rest of a global connection document.
  const connection = probe ? {} : loadConnectionWithFallback(serviceId);
  const mergedParams = {
    ...mergeParamsWithConnection(
      {
        ...(serviceConfig && typeof serviceConfig === 'object' ? serviceConfig : {}),
        ...(connection && typeof connection === 'object' ? connection : {}),
      },
      isPlainObject(params) ? params : {}
    ),
    [`${serviceId}_connection`]: connection,
    ...envelope.templateVars,
  };

  // Auth resolution
  const binding = probe?.binding || resolveServiceBinding(serviceId, auth);
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
        operatorProbe: Boolean(probe),
      });
      if (resolved) return resolved.result;
    } catch (err: any) {
      if (probe) {
        // Neither provider errors nor request headers may reach logs or the Web result.
        throw new OperatorServiceProbeError(
          err instanceof SecureFetchError && err.httpStatus === 401
            ? 'authentication_failed'
            : 'unavailable'
        );
      }
      logger.error(
        binding.authMode === 'secret-guard'
          ? '[ENGINE] Authenticated service alternative failed; provider diagnostics withheld.'
          : `  [ENGINE] Alternative failed: ${err.message}`
      );
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
  tenantBindingCapability?: object
): Promise<{ result: any; fromCache: boolean }> {
  const preset = getServicePresetRecord(serviceId);
  if (preset) enforceTenantBindingContract(serviceId, action, preset, tenantBindingCapability);
  const admission = tenantBindingCapability
    ? resolveTenantServiceEngineAdmission(tenantBindingCapability)
    : undefined;
  const { createHash } = await import('node:crypto');
  const cacheKey = `${action}:${createHash('sha256')
    .update(JSON.stringify(params ?? {}))
    .digest('hex')
    .slice(0, 16)}`;
  const admittedProjectId = admission?.securityScope.project_id;
  if (admission && cacheOpts.project_id && cacheOpts.project_id !== admittedProjectId) {
    throw new Error(
      '[POLICY_VIOLATION] Service cache project does not match admitted project scope'
    );
  }
  const cacheProjectId = admission
    ? admittedProjectId || admission.securityScope.tenant_slug || admission.securityScope.tenant_id
    : cacheOpts.project_id;
  const scopedCacheKey = admission
    ? `${admission.securityScope.tenant_slug ?? admission.securityScope.tenant_id ?? 'unknown'}:${cacheProjectId ?? '_tenant'}:${admission.bindingId}:${cacheKey}`
    : cacheKey;
  const { data: result, fromCache } = await fetchWithVaultCache(
    serviceId,
    scopedCacheKey,
    () => executeServicePreset(serviceId, action, params, auth, undefined, tenantBindingCapability),
    {
      ttlMs: cacheOpts.cache_ttl_ms,
      projectId: cacheProjectId,
      tier: cacheOpts.tier ?? 'confidential',
    }
  );
  if (fromCache) logger.info(`[ENGINE:VAULT] cache hit for ${serviceId}:${action}`);
  return { result, fromCache };
}
