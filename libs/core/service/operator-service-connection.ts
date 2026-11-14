import { credentialExecutionIdentity } from '../foundation/credential-binding.js';
/**
 * Personal-machine operator service registration and authentication status.
 * HTTP adapters MUST construct the principal from verified server-side evidence.
 * No URL, operation, credential reference, or raw provider result crosses this API.
 */
import { timingSafeEqual } from 'node:crypto';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import { loadConnectionDocument } from '../secret/secret-guard.js';
import { getServiceEndpointRecord, type CredentialSuffixKey } from './service-endpoint-registry.js';
import { getServicePresetRecord } from './service-preset-registry.js';
import { resolveServiceBinding } from './service-binding.js';
import { executeServicePreset } from './service-engine.js';
import { resolveTemplateValue } from './service-engine-helpers.js';
import {
  isIssuedInstallationOwnerGrant,
  type InstallationAccessMode,
  type InstallationOwnerGrant,
} from '../surface/installation-owner-access.js';
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
  /**
   * The installation-owner grant the surface adapter obtained for this
   * request (surface/installation-owner-access.ts). Only a grant issued in
   * this process counts; it lets the installation owner act from a
   * non-loopback session (a write needs its passkey step-up).
   */
  installationGrant?: InstallationOwnerGrant;
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

function assertLocalOperator(
  principal: OperatorServiceConnectionPrincipal,
  mode: InstallationAccessMode = 'read'
): void {
  if (getPluginExecutionContext() || credentialExecutionIdentity().personalClaim || !principal) {
    throw new Error('[OPERATOR_SERVICE_CONNECTION_DENIED]');
  }
  if (principal.installationGrant !== undefined) {
    // The grant is the whole proof: only resolveInstallationOwnerAccess can
    // put an object into the issued-grant set, so a copied or hand-built
    // grant fails here. (The adapter derives principalId FROM the grant, so
    // comparing the two would prove nothing.)
    if (!isIssuedInstallationOwnerGrant(principal.installationGrant, mode)) {
      throw new Error('[OPERATOR_SERVICE_CONNECTION_DENIED]');
    }
    return;
  }
  // Legacy in-process contract: a proven loopback localadmin principal.
  if (
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

/** Auth strategies whose credential the probe may inject from the admitted binding. */
const PROBE_AUTH_STRATEGIES = new Set(['bearer', 'bot', 'basic', 'api_key_query']);
const ACCESS_TOKEN_PLACEHOLDER = '{{accessToken}}';
const TEMPLATE_TOKEN_PATTERN = /\{\{[a-zA-Z0-9_.-]+\}\}/g;
const TEMPLATE_TOKEN_TEST = /\{\{[a-zA-Z0-9_.-]+\}\}/;

function isStaticTemplateFree(value: unknown): boolean {
  if (typeof value === 'string') return !TEMPLATE_TOKEN_TEST.test(value);
  if (Array.isArray(value)) return value.every(isStaticTemplateFree);
  if (value && typeof value === 'object') {
    return Object.values(value).every(isStaticTemplateFree);
  }
  // Numbers, booleans, null and absent fields are trivially template-free.
  return true;
}

/**
 * Substitutes catalog-pinned defaults into a preset template. {{accessToken}} is
 * left intact for the admitted binding; any other unresolved token fails closed.
 */
function substituteProbeDefaults(
  text: string | undefined,
  params: Record<string, string>
): string | undefined {
  if (typeof text !== 'string') return text;
  const resolved = text.replace(TEMPLATE_TOKEN_PATTERN, (match) => {
    if (match === ACCESS_TOKEN_PLACEHOLDER) return match;
    const key = match.slice(2, -2);
    return Object.prototype.hasOwnProperty.call(params, key) ? params[key] : match;
  });
  const leftover = resolved.replaceAll(ACCESS_TOKEN_PLACEHOLDER, '');
  return TEMPLATE_TOKEN_TEST.test(leftover) ? undefined : resolved;
}

function pathUsesOnlyAccessToken(path: string): boolean {
  return !TEMPLATE_TOKEN_TEST.test(path.replaceAll(ACCESS_TOKEN_PLACEHOLDER, ''));
}

/** A base URL may never carry the admitted credential; only paths may (Telegram). */
function baseUrlCarriesNoCredential(url: string): boolean {
  return !url.includes(ACCESS_TOKEN_PLACEHOLDER);
}

/**
 * Binding fields the probe may read. `basicAuthToken` is a schema-level suffix
 * class with no binding slot, so a secretKey mapped there can never resolve.
 */
const BINDABLE_SUFFIX_KEYS = [
  'accessToken',
  'appToken',
  'refreshToken',
  'clientId',
  'clientSecret',
  'redirectUri',
] as const;
type BindableSuffixKey = (typeof BINDABLE_SUFFIX_KEYS)[number];

/** Keys the binding must resolve for a strategy: basic also needs the user part. */
function probeBindingKeys(strategy: string, secretField: BindableSuffixKey): CredentialSuffixKey[] {
  if (strategy !== 'basic') return [secretField];
  return ['accessToken', 'clientId', 'clientSecret'];
}

/**
 * Headers that carry credentials or otherwise decide authentication. The probe
 * engine injects the admitted token itself, so a preset may never set these.
 */
const CREDENTIAL_HEADER_NAMES = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'private-token',
  'cookie',
]);

function headersAreProbeSafe(headers: unknown): boolean {
  if (headers === undefined) return true;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return false;
  return Object.entries(headers).every(
    ([name, value]) =>
      !CREDENTIAL_HEADER_NAMES.has(name.toLowerCase()) && isStaticTemplateFree(value)
  );
}

function readConnectionFields(
  entry: OperatorServiceConnectionCatalogEntry
): Record<string, string> {
  const names = entry.probe.connectionFields;
  if (!names?.length) return {};
  const document = loadConnectionDocument(entry.serviceId);
  const fields: Record<string, string> = {};
  for (const name of names) {
    const value: unknown = document[name];
    if (typeof value === 'string' && value.trim().length > 0) fields[name] = value.trim();
  }
  return fields;
}

/** Validate the actual runtime preset before admitting a single read-only API call. */
function prepareProbe(
  entry: OperatorServiceConnectionCatalogEntry,
  connectionFields: Record<string, string>
) {
  const serviceConfig = getServiceEndpointRecord(entry.serviceId);
  if (!serviceConfig?.preset_path) return null;
  const preset = getServicePresetRecord(entry.serviceId, serviceConfig.preset_path);
  const operation = preset?.operations[entry.authOperation];
  if (!preset || !operation) return null;

  // Pinned defaults and declared connection fields resolve provider
  // placeholders (host, space, domain) inside the admitted snapshot; none of
  // them ever reaches the request as user-supplied data.
  const templateVars = { ...(entry.probe.params ?? {}), ...connectionFields };
  const presetBaseUrl = typeof preset.base_url === 'string' ? preset.base_url : undefined;
  const resolvedBaseUrl = substituteProbeDefaults(
    presetBaseUrl || serviceConfig.base_url,
    templateVars
  );
  const resolvedConfigBaseUrl = substituteProbeDefaults(serviceConfig.base_url, templateVars);
  const resolvedProbeBaseUrl = substituteProbeDefaults(entry.probe.baseUrl, templateVars);
  const resolvedPath = substituteProbeDefaults(operation.path, templateVars);
  if (
    resolvedBaseUrl === undefined ||
    resolvedBaseUrl !== resolvedProbeBaseUrl ||
    (serviceConfig.base_url !== undefined && resolvedConfigBaseUrl !== resolvedBaseUrl) ||
    resolvedPath === undefined ||
    resolvedPath !== entry.probe.path ||
    !pathUsesOnlyAccessToken(resolvedPath) ||
    !baseUrlCarriesNoCredential(resolvedBaseUrl)
  )
    return null;

  const strategy = String(preset.auth_strategy).toLowerCase();
  const pathEmbeddedCredential =
    strategy === 'none' && resolvedPath.includes(ACCESS_TOKEN_PLACEHOLDER);
  if (!PROBE_AUTH_STRATEGIES.has(strategy) && !pathEmbeddedCredential) return null;
  // auth_params only takes effect under api_key_query; elsewhere it is dead
  // configuration that would smuggle the token into an unreviewed channel.
  if (
    strategy !== 'api_key_query' &&
    (preset.auth_params !== undefined || operation.auth_params !== undefined)
  )
    return null;

  const resolvedPayload = operation.payload_template
    ? substituteOperationPayload(operation.payload_template)
    : undefined;
  if (
    operation.type !== 'api' ||
    operation.risk !== 'read' ||
    operation.kind !== 'capture' ||
    operation.approval_required !== false ||
    operation.method !== entry.probe.method ||
    operation.alternatives !== undefined ||
    operation.base_url !== undefined ||
    operation.output_mapping !== undefined ||
    operation.auth_strategy !== undefined ||
    operation.allow_local_network === true ||
    preset.allow_local_network === true ||
    serviceConfig.allow_local_network === true ||
    preset.tenant_binding_required === true ||
    operation.tenant_binding_required === true ||
    Object.keys(operation.parameters || {}).length !== 0 ||
    // Static non-credential headers only: a templated header could smuggle an
    // unrelated secret and a credential header would fight the admitted token.
    !headersAreProbeSafe(preset.headers) ||
    !headersAreProbeSafe(operation.headers) ||
    // A pinned payload must deep-equal the operation's static template; a
    // templated payload could reference credentials outside the admission.
    (operation.payload_template !== undefined && resolvedPayload === undefined) ||
    (operation.payload_template === undefined && entry.probe.payload !== undefined) ||
    (resolvedPayload !== undefined &&
      JSON.stringify(resolvedPayload) !== JSON.stringify(entry.probe.payload)) ||
    // Credential-injection auth params may reference the admitted token only.
    (preset.auth_params !== undefined &&
      !authParamsReferenceOnlyAccessToken(preset.auth_params, templateVars)) ||
    (operation.auth_params !== undefined &&
      !authParamsReferenceOnlyAccessToken(operation.auth_params, templateVars))
  )
    return null;

  // The engine runs the admitted snapshot, so freeze resolved values into it.
  const admittedPreset = structuredClone(preset);
  admittedPreset.base_url = resolvedBaseUrl;
  admittedPreset.operations[entry.authOperation].path = resolvedPath;

  // The catalog's secretKey must map to a bindable suffix class so the
  // registered credential can be compared with what the binding resolved.
  const secretField = BINDABLE_SUFFIX_KEYS.find((key) =>
    serviceConfig.credential_suffixes[key]?.includes(entry.secretKey)
  );
  if (!secretField) return null;
  const bindingKeys = probeBindingKeys(strategy, secretField);
  const credentialNames = bindingKeys.flatMap((key) =>
    serviceConfig.credential_suffixes[key].map(
      (suffix) => entry.serviceId.toUpperCase() + '_' + suffix
    )
  );
  return {
    serviceConfig: structuredClone(serviceConfig),
    preset: admittedPreset,
    credentialNames,
    bindingKeys,
    secretField,
    strategy,
  };
}

function substituteOperationPayload(payloadTemplate: unknown): Record<string, unknown> | undefined {
  const resolved = resolveTemplateValue(payloadTemplate, {});
  if (resolved === undefined || !isStaticTemplateFree(resolved)) return undefined;
  return resolved as Record<string, unknown>;
}

function authParamsReferenceOnlyAccessToken(
  authParams: unknown,
  probeParams: Record<string, string>
): boolean {
  if (!authParams || typeof authParams !== 'object') return false;
  const { key, value } = authParams as { key?: unknown; value?: unknown };
  if (typeof key !== 'string' || !key.trim() || TEMPLATE_TOKEN_TEST.test(key)) return false;
  if (typeof value !== 'string') return false;
  const resolved = substituteProbeDefaults(value, probeParams);
  return resolved === ACCESS_TOKEN_PLACEHOLDER;
}

function responseFieldAtPath(record: Record<string, unknown>, dottedPath: string): unknown {
  let value: unknown = record;
  for (const segment of dottedPath.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function validAuthenticationResult(
  result: unknown,
  entry: OperatorServiceConnectionCatalogEntry
): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const record = result as Record<string, unknown>;
  return entry.probe.successRules.every(({ field, kind }) => {
    const value = responseFieldAtPath(record, field);
    if (kind === 'present') return value !== undefined && value !== null;
    if (value === undefined) return false;
    if (kind === 'true') return value === true;
    if (kind === 'positive_integer')
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
    if (kind === 'non_empty_array') return Array.isArray(value) && value.length > 0;
    return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
  });
}

export async function probeOperatorServiceConnection(input: {
  principal: OperatorServiceConnectionPrincipal;
  serviceId: string;
}): Promise<OperatorServiceConnectionProbeResult> {
  assertLocalOperator(input.principal, 'write');
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
    // Registration gates admission: a missing document (or secret field) is a
    // credential problem, not a contract failure — and placeholder resolution
    // depends on the document's connection fields.
    const candidate = registrationCandidate(entry);
    if (!candidate) return response('credential_missing');
    const connectionFields = readConnectionFields(entry);
    const declaredFields = entry.probe.connectionFields ?? [];
    if (declaredFields.some((name) => connectionFields[name] === undefined))
      return response('credential_missing');
    const prepared = prepareProbe(entry, connectionFields);
    if (!prepared) return response('unsupported');
    return await runOperatorServiceProbeScope(
      entry.serviceId,
      entry.authOperation,
      prepared.credentialNames,
      async () => {
        let binding;
        try {
          binding = resolveServiceBinding(entry.serviceId, 'secret-guard', prepared.bindingKeys);
        } catch {
          return response('unavailable');
        }
        // The probe must verify the credential the request actually sends:
        // the engine injects accessToken for non-basic strategies and prefers
        // the client pair for basic, falling back to a pre-encoded
        // accessToken. Verifying a resolved sibling field instead would let an
        // ambient credential answer for a different registered secret.
        const sentSecret =
          prepared.strategy === 'basic' && binding.clientId && binding.clientSecret
            ? binding.clientSecret
            : binding.accessToken;
        if (!sentSecret) return response('credential_missing');
        if (!sameSecret(candidate, sentSecret)) return response('credential_shadowed');
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
