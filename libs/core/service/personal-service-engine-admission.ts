import { credentialExecutionIdentity } from '../foundation/credential-binding.js';
import { resolvePersonalServiceCredentialAdmission } from '../secret/personal-service-credential-admission.js';
import { getServicePresetRecord } from './service-preset-registry.js';
import { getServiceEndpointRecord } from './service-endpoint-registry.js';

const denied = () => new Error('[CREDENTIAL_PROVENANCE_DENIED] Personal service admission denied');

/** An operation capability never authorizes another transport, fallback or credential lookup. */
export function personalServiceEngineAdmission(
  capability: object | undefined,
  serviceId: string,
  action?: string
) {
  if (!credentialExecutionIdentity().personalClaim || !capability) throw denied();
  const admitted = resolvePersonalServiceCredentialAdmission(capability, serviceId, action);
  const preset = getServicePresetRecord(serviceId);
  const operation = preset?.operations[admitted.action];
  const routes =
    operation?.alternatives ?? (operation ? [{ ...operation, type: operation.type ?? 'api' }] : []);
  if (
    !operation ||
    operation.risk !== 'read' ||
    operation.approval_required !== false ||
    routes.length !== 1 ||
    (routes[0].type ?? 'api') !== 'api' ||
    !['GET', 'HEAD'].includes(String(routes[0].method ?? 'GET').toUpperCase()) ||
    !['bearer', 'bot'].includes(
      String(routes[0].auth_strategy ?? preset?.auth_strategy).toLowerCase()
    ) ||
    typeof routes[0].path !== 'string' ||
    /[{}?#]/.test(routes[0].path) ||
    routes[0].path.split('/').some((part: string) => part === '..' || part === '.')
  )
    throw denied();
  return admitted;
}

export function assertPersonalServiceTransport(
  input: {
    personalCredentialCapability?: object;
    serviceId: string;
    action: string;
    alt: unknown;
    preset: unknown;
    serviceConfig: unknown;
    authSelector?: string;
  },
  url?: string
): void {
  if (!credentialExecutionIdentity().personalClaim && !input.personalCredentialCapability) return;
  personalServiceEngineAdmission(input.personalCredentialCapability, input.serviceId, input.action);
  const preset = getServicePresetRecord(input.serviceId)!;
  const endpoint = getServiceEndpointRecord(input.serviceId)!;
  const operation = preset.operations[input.action];
  const route = operation.alternatives?.[0] ?? { ...operation, type: operation.type ?? 'api' };
  if (
    input.authSelector !== 'secret-guard' ||
    JSON.stringify(input.alt) !== JSON.stringify(route) ||
    JSON.stringify(input.preset) !== JSON.stringify(preset) ||
    JSON.stringify(input.serviceConfig) !== JSON.stringify(endpoint)
  )
    throw denied();
  if (url !== undefined) {
    try {
      const base = String(route.base_url ?? preset.base_url ?? endpoint.base_url);
      if (/[{}]/.test(base)) throw denied();
      const expected = new URL(String(preset.base_url ?? endpoint.base_url));
      const destination = new URL(`${base}/${route.path}`);
      const actual = new URL(url);
      if (
        actual.protocol !== 'https:' ||
        actual.username ||
        actual.password ||
        expected.protocol !== 'https:' ||
        expected.username ||
        expected.password ||
        expected.search ||
        expected.hash ||
        destination.origin !== expected.origin ||
        destination.search ||
        destination.hash ||
        actual.origin !== expected.origin ||
        actual.pathname !== destination.pathname ||
        actual.search ||
        actual.hash
      )
        throw denied();
    } catch {
      throw denied();
    }
  }
}
