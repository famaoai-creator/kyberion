/**
 * Personal-machine operator service registration and authentication status.
 * HTTP adapters MUST construct the principal from verified server-side evidence.
 * No URL, operation, credential reference, or raw provider result crosses this API.
 */
import { timingSafeEqual } from 'node:crypto';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import { loadConnectionDocument } from '../secret/secret-guard.js';
import { getServiceEndpointRecord } from './service-endpoint-registry.js';
import { getServicePresetRecord } from './service-preset-registry.js';
import { resolveServiceBinding } from './service-binding.js';
import { executeServicePreset } from './service-engine.js';
import {
  loadOperatorServiceConnectionCatalog,
  type OperatorServiceConnectionCatalogEntry,
} from './operator-service-connection-catalog.js';
import {
  issueOperatorServiceProbeAdmission,
  OperatorServiceProbeError,
  runOperatorServiceProbeScope,
} from './operator-service-connection-admission.js';

export interface OperatorServiceConnectionPrincipal {
  role: string;
  source: 'token' | 'loopback' | 'anonymous';
  principalId?: string;
  /** A trusted transport adapter proved a direct loopback peer; never a request parameter. */
  loopback: boolean;
}

export interface OperatorServiceConnectionDescriptor {
  serviceId: string;
  label: string;
  secretKey: string;
  authOperation: string;
  setupUrl: string;
  scopeNotice: string;
  credential_present: boolean;
}

export type OperatorServiceConnectionStatus =
  | 'authenticated'
  | 'credential_missing'
  | 'credential_shadowed'
  | 'authentication_failed'
  | 'unavailable'
  | 'unsupported';

export interface OperatorServiceConnectionProbeResult {
  serviceId: string;
  status: OperatorServiceConnectionStatus;
  checkedAt: string;
}

function assertLocalOperator(principal: OperatorServiceConnectionPrincipal): void {
  if (
    getPluginExecutionContext() ||
    !principal ||
    principal.loopback !== true ||
    principal.role !== 'localadmin' ||
    principal.source !== 'loopback' ||
    typeof principal.principalId !== 'string' ||
    !principal.principalId.trim()
  ) {
    throw new Error('[OPERATOR_SERVICE_CONNECTION_DENIED]');
  }
}

function registrationCandidate(entry: OperatorServiceConnectionCatalogEntry): string | undefined {
  const document = loadConnectionDocument(entry.serviceId);
  const value: unknown = document[entry.secretKey.toLowerCase()];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function listOperatorServiceConnections(
  principal: OperatorServiceConnectionPrincipal
): OperatorServiceConnectionDescriptor[] {
  assertLocalOperator(principal);
  try {
    return loadOperatorServiceConnectionCatalog().map((entry) => ({
      serviceId: entry.serviceId,
      label: entry.label,
      secretKey: entry.secretKey,
      authOperation: entry.authOperation,
      setupUrl: entry.setupUrl,
      scopeNotice: entry.scopeNotice,
      credential_present: registrationCandidate(entry) !== undefined,
    }));
  } catch {
    throw new Error('[OPERATOR_SERVICE_CONNECTION_UNAVAILABLE]');
  }
}

/** Validate the actual runtime preset before admitting a single read-only API call. */
function prepareProbe(entry: OperatorServiceConnectionCatalogEntry) {
  const serviceConfig = getServiceEndpointRecord(entry.serviceId);
  if (!serviceConfig?.preset_path) return null;
  const preset = getServicePresetRecord(entry.serviceId, serviceConfig.preset_path);
  const operation = preset?.operations[entry.authOperation];
  if (
    !preset ||
    !operation ||
    operation.type !== 'api' ||
    operation.risk !== 'read' ||
    operation.kind !== 'capture' ||
    operation.approval_required !== false ||
    operation.method !== entry.probe.method ||
    operation.path !== entry.probe.path ||
    operation.alternatives !== undefined ||
    operation.base_url !== undefined ||
    operation.payload_template !== undefined ||
    operation.output_mapping !== undefined ||
    operation.headers !== undefined ||
    operation.auth_params !== undefined ||
    operation.auth_strategy !== undefined ||
    operation.allow_local_network === true ||
    preset.allow_local_network === true ||
    Object.keys(preset.headers || {}).length !== 0 ||
    serviceConfig.allow_local_network === true ||
    preset.tenant_binding_required === true ||
    operation.tenant_binding_required === true ||
    String(preset.auth_strategy).toLowerCase() !== 'bearer' ||
    (preset.base_url || serviceConfig.base_url) !== entry.probe.baseUrl ||
    (serviceConfig.base_url !== undefined && serviceConfig.base_url !== entry.probe.baseUrl) ||
    Object.keys(operation.parameters || {}).length !== 0
  )
    return null;
  // Only access-token suffixes are admitted; optional OAuth/app credentials are never read.
  const credentialNames = serviceConfig.credential_suffixes.accessToken.map(
    (suffix) => entry.serviceId.toUpperCase() + '_' + suffix
  );
  if (!credentialNames.includes(entry.serviceId.toUpperCase() + '_' + entry.secretKey)) return null;
  return {
    serviceConfig: structuredClone(serviceConfig),
    preset: structuredClone(preset),
    credentialNames,
  };
}

function validAuthenticationResult(
  result: unknown,
  entry: OperatorServiceConnectionCatalogEntry
): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  return entry.probe.successRules.every(({ field, kind }) => {
    if (!Object.hasOwn(record, field)) return false;
    const value = record[field];
    if (kind === 'true') return value === true;
    if (kind === 'positive_integer')
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
  });
}

export async function probeOperatorServiceConnection(input: {
  principal: OperatorServiceConnectionPrincipal;
  serviceId: string;
}): Promise<OperatorServiceConnectionProbeResult> {
  assertLocalOperator(input.principal);
  const response = (
    status: OperatorServiceConnectionStatus
  ): OperatorServiceConnectionProbeResult => ({
    serviceId: input.serviceId,
    status,
    checkedAt: new Date().toISOString(),
  });
  try {
    const entry = loadOperatorServiceConnectionCatalog().find(
      (item) => item.serviceId === input.serviceId
    );
    if (!entry) return response('unsupported');
    const prepared = prepareProbe(entry);
    if (!prepared) return response('unsupported');
    return await runOperatorServiceProbeScope(
      entry.serviceId,
      entry.authOperation,
      prepared.credentialNames,
      async () => {
        const candidate = registrationCandidate(entry);
        if (!candidate) return response('credential_missing');
        let binding;
        try {
          binding = resolveServiceBinding(entry.serviceId, 'secret-guard', ['accessToken']);
        } catch {
          return response('unavailable');
        }
        if (!binding.accessToken) return response('credential_missing');
        if (!sameSecret(candidate, binding.accessToken)) return response('credential_shadowed');
        const capability = issueOperatorServiceProbeAdmission({
          serviceId: entry.serviceId,
          action: entry.authOperation,
          binding,
          serviceConfig: prepared.serviceConfig,
          preset: prepared.preset,
        });
        const result = await executeServicePreset(
          entry.serviceId,
          entry.authOperation,
          {},
          'secret-guard',
          undefined,
          undefined,
          capability
        );
        // A concurrent rotation invalidates this snapshot; never mark the newer registration verified.
        const currentCandidate = registrationCandidate(entry);
        if (!currentCandidate || !sameSecret(candidate, currentCandidate))
          return response('unavailable');
        return response(
          validAuthenticationResult(result, entry) ? 'authenticated' : 'authentication_failed'
        );
      }
    );
  } catch (error) {
    return response(error instanceof OperatorServiceProbeError ? error.status : 'unavailable');
  }
}
