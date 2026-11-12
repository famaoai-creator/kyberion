import { credentialExecutionIdentity } from '../foundation/credential-binding.js';
import { resolveTenantAlias } from '../governance/context-security-scope.js';
import type { StorageDataTier } from '../storage-layout.js';
import { consumeScopedServiceCaptureAdmission } from './service-capture-admission.js';
import { createLogger } from '../logger.js';
import {
  currentHumanExecutionAuthorization,
  hasHumanExecutionContext,
} from '../governance/human-execution.js';
import {
  currentDelegatedExecution,
  hasDelegatedExecutionContext,
  verifyDelegatedExecution,
  hashDelegatedServiceConfiguration,
} from '../governance/delegated-execution.js';
import {
  consumeOperatorServiceProbeAdmission,
  OperatorServiceProbeError,
} from './operator-service-connection-admission.js';
import { SecureFetchError } from '../network.js';
import { loadServiceEndpointsCatalog } from './service-endpoint-registry.js';
import { fetchWithVaultCache } from '../storage/data-vault.js';
import { resolveServiceBinding } from './service-binding.js';
import { getServicePresetRecord } from './service-preset-registry.js';
import {
  loadConnectionWithFallback,
  mergeParamsWithConnection,
  isPlainObject,
  resolveRequestEnvelope,
  ServiceEffectOutcomeUnknownError,
} from './service-engine-helpers.js';
import {
  executeServicePresetAlternative,
  isReplaySafeServiceOperation,
} from './service-engine-execution.js';
import {
  authorizeTenantServiceAction,
  listServiceBindingRecords,
  loadServiceBindingRecord,
} from './service-binding-registry.js';
import { resolveTenantServiceEngineAdmission } from './service-engine-admission.js';

const logger = createLogger('service-engine');

export { executeMcp } from './service-engine-execution.js';
export { withMcpStartupAttempt } from './service-mcp-execution.js';
export type { McpApprovalContinuation } from './service-mcp-execution.js';

export interface ServicePresetCacheOptions {
  /** When set, the result is cached in the Data Vault for this many milliseconds. */
  cache_ttl_ms?: number;
  /** Project scope for the vault entry (defaults to _global). */
  project_id?: string;
  /** Data tier for vault storage (defaults to confidential). */
  tier?: StorageDataTier;
}

function enforceTenantBindingContract(
  serviceId: string,
  action: string,
  preset: NonNullable<ReturnType<typeof getServicePresetRecord>>,
  tenantBindingCapability?: object
): void {
  const operation = preset.operations[action];
  if (!operation) throw new Error(`Operation "${action}" not found in presets for ${serviceId}`);
  const identity = credentialExecutionIdentity();
  const operationBindingRequired =
    Boolean(identity.tenantSlug || tenantBindingCapability) ||
    preset.tenant_binding_required === true ||
    operation.tenant_binding_required === true;
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
  const admittedScope = tenantBindingContext.securityScope;
  if (
    !identity.tenantSlug ||
    identity.tenantSlug !== resolveTenantAlias(admittedScope) ||
    (identity.missionId && identity.missionId !== admittedScope.mission_id) ||
    (identity.taskId && identity.taskId !== admittedScope.task_id)
  ) {
    throw new Error(
      '[POLICY_VIOLATION] Tenant service admission does not match execution identity'
    );
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
  const delegated = tenantBindingContext.delegated;
  const delegatedAllowed =
    delegated &&
    currentDelegatedExecution(delegated.target.operationId, delegated.target.params) &&
    verifyDelegatedExecution({ ...delegated.target, permitId: delegated.permitId });
  const human = tenantBindingContext.humanExecution;
  const currentHuman =
    human && currentHumanExecutionAuthorization(human.target.operationId, human.target.params);
  const humanAllowed = currentHuman && currentHuman.reference.claimId === human!.reference.claimId;
  if (
    approvalRequired &&
    tenantBindingContext.approvalGranted !== true &&
    !delegatedAllowed &&
    !humanAllowed
  ) {
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
  operatorProbeCapability?: object,
  informationAssetCaptureCapability?: object
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

  let captureTransport:
    Awaited<ReturnType<typeof consumeScopedServiceCaptureAdmission>> | undefined;
  if (informationAssetCaptureCapability) {
    if (tenantBindingCapability || operatorProbeCapability)
      throw new Error(
        '[POLICY_VIOLATION] Capture admission cannot be combined with another authority'
      );
    captureTransport = await consumeScopedServiceCaptureAdmission(
      informationAssetCaptureCapability,
      serviceId,
      action,
      params,
      preset,
      serviceConfig
    );
  } else {
    enforceTenantBindingContract(serviceId, action, preset, tenantBindingCapability);
  }
  const activeDelegation = currentDelegatedExecution(`service:preset:${serviceId}:${action}`, {
    request: params,
    auth,
  });
  const activeHuman = currentHumanExecutionAuthorization(`service:preset:${serviceId}:${action}`, {
    request: params,
    auth,
  });
  if (hasHumanExecutionContext() && !activeHuman) {
    throw new Error(
      '[POLICY_VIOLATION] Actual service operation/payload differs from human-authorized effect'
    );
  }
  if (hasDelegatedExecutionContext() && !activeDelegation) {
    throw new Error(
      '[POLICY_VIOLATION] Actual service operation/payload no longer matches delegated authority'
    );
  }
  if (tenantBindingCapability) {
    const admitted = resolveTenantServiceEngineAdmission(tenantBindingCapability);
    if (
      admitted?.delegated &&
      (!activeDelegation ||
        !verifyDelegatedExecution({
          ...admitted.delegated.target,
          permitId: admitted.delegated.permitId,
        }))
    ) {
      throw new Error('[POLICY_VIOLATION] Delegated service effect no longer authorized');
    }
  }

  const alternatives = op.alternatives || [{ ...op, type: op.type || 'api' }];
  const envelope = resolveRequestEnvelope(params);
  // A probe must not load or template the rest of a global connection document.
  // Tenant admission uses governed endpoint config, request params and scoped
  // credentials only; a personal connection document is never a tenant default.
  const connection =
    captureTransport?.connection ??
    (probe || tenantBindingCapability ? {} : loadConnectionWithFallback(serviceId));
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

  // Tenant credentials must come from the exact admitted connection, never the service default.
  const selectedAdmission = tenantBindingCapability
    ? resolveTenantServiceEngineAdmission(tenantBindingCapability)
    : undefined;
  if (
    selectedAdmission &&
    auth === 'secret-guard' &&
    ((activeDelegation &&
      activeDelegation.target.serviceBindingId !== selectedAdmission.bindingId) ||
      (activeHuman && activeHuman.target.serviceBindingId !== selectedAdmission.bindingId))
  )
    throw new Error(
      '[CREDENTIAL_PROVENANCE_DENIED] Service selection differs from authorized effect'
    );
  const selectedBinding =
    selectedAdmission && auth === 'secret-guard'
      ? loadServiceBindingRecord(selectedAdmission.bindingId)
      : undefined;
  if (selectedAdmission && auth === 'secret-guard' && !selectedBinding) {
    throw new Error('[CREDENTIAL_PROVENANCE_DENIED] Selected service binding is unavailable');
  }
  // Auth resolution
  const binding =
    captureTransport?.binding ??
    probe?.binding ??
    resolveServiceBinding(
      serviceId,
      auth,
      undefined,
      selectedBinding ?? undefined,
      selectedAdmission
        ? {
            tenant_slug: resolveTenantAlias(selectedAdmission.securityScope)!,
            project_id: selectedAdmission.securityScope.project_id,
            mission_id: selectedAdmission.securityScope.mission_id,
            task_id: selectedAdmission.securityScope.task_id,
            action,
          }
        : undefined
    );
  const executionTenant = activeDelegation?.target.tenantSlug ?? activeHuman?.target.tenantSlug;
  const effectConfigurationHash = executionTenant
    ? hashDelegatedServiceConfiguration({
        config: serviceConfig,
        preset,
        connection,
        binding,
        tenantBindings: listServiceBindingRecords().filter(
          (record) =>
            (record.tenant_slug === executionTenant ||
              record.binding_id === selectedAdmission?.bindingId) &&
            (record.service_id === serviceId || record.service_type === serviceId)
        ),
      })
    : undefined;
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
        authSelector: auth,
        effectConfigurationHash,
        operatorProbe: Boolean(probe),
        captureProviderEnvironment: captureTransport?.providerEnvironment,
        captureAuthority: captureTransport?.validate,
      });
      if (resolved) return resolved.result;
    } catch (err: any) {
      if (informationAssetCaptureCapability) {
        const candidate =
          err instanceof SecureFetchError
            ? err.httpStatus
            : (err?.status ?? err?.statusCode ?? err?.httpStatus);
        const status =
          typeof candidate === 'number' &&
          Number.isInteger(candidate) &&
          candidate >= 400 &&
          candidate <= 599
            ? candidate
            : serviceId === 'google-workspace' &&
                action === 'gmail_history_list' &&
                /\b404\b/.test(String(err))
              ? 404
              : undefined;
        throw Object.assign(
          new Error('information_asset_capture_failed'),
          status ? { status } : {}
        );
      }
      if (err instanceof ServiceEffectOutcomeUnknownError) throw err;
      if (probe) {
        // Neither provider errors nor request headers may reach logs or the Web result.
        throw new OperatorServiceProbeError(
          err instanceof SecureFetchError && err.httpStatus === 401
            ? 'authentication_failed'
            : 'unavailable'
        );
      }
      // An attempted mutation may already have completed remotely. Switching
      // transports would repeat the same effect under one admission.
      if (!isReplaySafeServiceOperation(op)) {
        if (binding.authMode === 'secret-guard') {
          throw new Error(
            `Service execution outcome unknown for ${serviceId}:${action}; provider diagnostics withheld`
          );
        }
        throw err;
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
  if (!preset) throw new Error(`No service preset found for: ${serviceId}`);
  enforceTenantBindingContract(serviceId, action, preset, tenantBindingCapability);
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
