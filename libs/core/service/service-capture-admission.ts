import '../governance/authorization-overlay.js';
import { subjectAuthorization } from '../foundation/authorization-registry.js';
/** Internal exact-request, single-use scoped read admission. No domain-layer imports belong here. */
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import {
  loadServiceEndpointsCatalog,
  type ResolvedServiceEndpointRecord,
} from './service-endpoint-registry.js';
import { getServicePresetRecord, type ServicePresetRecord } from './service-preset-registry.js';
import type { ServiceBinding } from './service-binding.js';
export const INFORMATION_ASSET_REVIEW_THREADS_QUERY =
  'query InformationAssetReviewThreads($owner: String!, $repo: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { headRefOid reviewThreads(first: 100, after: $after) { nodes { id isResolved isOutdated } pageInfo { hasNextPage endCursor } } } } }';
export function buildReviewThreadsCaptureParams(variables: {
  owner: string;
  repo: string;
  number: number;
  after?: string | null;
}): Record<string, unknown> {
  return {
    body: {
      query: INFORMATION_ASSET_REVIEW_THREADS_QUERY,
      variables: { ...variables, after: variables.after ?? null },
    },
  };
}
export function assertCanonicalServiceCaptureAuthorization(service: string, action: string): void {
  const authorization = subjectAuthorization('service:' + service + ':preset:' + action);
  if (
    !authorization.declared ||
    authorization.effectClass !== 'external_read' ||
    authorization.authority.kind !== 'admission' ||
    authorization.authority.boundary !== 'external' ||
    authorization.approvalDomain !== undefined
  )
    throw new Error('information_asset_capture_canonical_authority_denied');
}
function assertCaptureRequest(request: ScopedServiceCaptureRequest): void {
  assertCanonicalServiceCaptureAuthorization(request.service_id, request.action);
  if (request.service_id !== 'github' || request.action !== 'get_review_threads') return;
  const body = request.params.body as
    { query?: unknown; variables?: Record<string, unknown> } | undefined;
  const vars = body?.variables;
  if (
    Object.keys(request.params).some((key) => key !== 'body') ||
    !body ||
    body.query !== INFORMATION_ASSET_REVIEW_THREADS_QUERY ||
    Object.keys(body).some((key) => !['query', 'variables'].includes(key)) ||
    !vars ||
    Object.keys(vars).some((key) => !['owner', 'repo', 'number', 'after'].includes(key)) ||
    typeof vars.owner !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(vars.owner) ||
    typeof vars.repo !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(vars.repo) ||
    typeof vars.number !== 'number' ||
    !Number.isSafeInteger(vars.number) ||
    vars.number < 1 ||
    vars.number > 2147483647 ||
    (vars.after !== null &&
      (typeof vars.after !== 'string' || vars.after.length > 2048 || vars.after.includes('\0')))
  )
    throw new Error('information_asset_capture_fixed_graphql_query_required');
}
export interface ScopedServiceCaptureRequest {
  service_id: string;
  action: string;
  params: Record<string, unknown>;
}
export interface ScopedServiceCaptureTransport {
  binding: ServiceBinding;
  /** Bound connection only. Personal/global fallback documents are never merged. */
  connection: Record<string, unknown>;
  providerEnvironment?: Record<string, string>;
  validate?: () => void;
}
interface Admission {
  requestSnapshot: string;
  presetSnapshot: string;
  endpointSnapshot: string;
  expires: number;
  verify: () => Promise<ScopedServiceCaptureTransport>;
}
const admissions = new WeakMap<object, Admission>();
// Snapshots remain private to the single-use, 30-second WeakMap capability.
// Compare exact serialized values without deriving or persisting credential fingerprints.
function snapshot(input: unknown): string {
  return JSON.stringify(input);
}
function presetSnapshot(preset: ServicePresetRecord, action: string): string {
  const { operations: _operations, ...configuration } = preset;
  return snapshot({ configuration, operation: preset.operations[action] });
}
export function assertReadOnlyServiceCapture(
  service: string,
  action: string,
  rawOperation?: unknown
): void {
  assertCanonicalServiceCaptureAuthorization(service, action);
  const raw: unknown = rawOperation ?? getServicePresetRecord(service)?.operations[action];
  if (!raw || typeof raw !== 'object')
    throw new Error('information_asset_capture_operation_missing');
  const operation = raw as Record<string, unknown>;
  if (
    operation.kind !== 'capture' ||
    operation.risk !== 'read' ||
    operation.approval_required === true
  )
    throw new Error('information_asset_explicit_capture_read_required:' + service + '/' + action);
  if (operation.type !== undefined && !['api', 'cli'].includes(String(operation.type)))
    throw new Error('information_asset_capture_transport_denied');
  if (operation.type === 'cli') {
    const reads: Record<string, string[]> = {
      gmail_profile_get: ['gmail', 'users', 'getProfile', '--params', '{{params}}'],
      gmail_messages_list: ['gmail', 'users', 'messages', 'list', '--params', '{{params}}'],
      gmail_message_get: ['gmail', 'users', 'messages', 'get', '--params', '{{params}}'],
      gmail_history_list: ['gmail', 'users', 'history', 'list', '--params', '{{params}}'],
      gmail_thread_get: ['gmail', 'users', 'threads', 'get', '--params', '{{params}}'],
    };
    if (
      service !== 'google-workspace' ||
      operation.command !== 'gws' ||
      !reads[action] ||
      JSON.stringify(operation.args) !== JSON.stringify(reads[action])
    )
      throw new Error('information_asset_capture_cli_denied');
  }
  if (operation.alternatives !== undefined)
    throw new Error('information_asset_capture_alternatives_denied');
  const fixedGraphql =
    service === 'github' &&
    action === 'get_review_threads' &&
    operation.type === 'api' &&
    operation.method === 'POST' &&
    operation.path === 'graphql' &&
    operation.payload_template === undefined;
  if (service === 'github' && action === 'get_review_threads' && !fixedGraphql)
    throw new Error('information_asset_capture_fixed_graphql_post_required');
  if (
    operation.type !== 'cli' &&
    !fixedGraphql &&
    !['GET', 'HEAD'].includes(String(operation.method).toUpperCase())
  )
    throw new Error('information_asset_capture_http_method_denied');
}
export async function issueScopedServiceCaptureAdmission(
  request: ScopedServiceCaptureRequest,
  verify: () => Promise<ScopedServiceCaptureTransport>
): Promise<object> {
  assertCaptureRequest(request);
  if (getPluginExecutionContext()) throw new Error('information_asset_capture_scope_denied');
  const config = loadServiceEndpointsCatalog().services[request.service_id];
  const preset = config?.preset_path
    ? getServicePresetRecord(request.service_id, config.preset_path)
    : null;
  if (!preset) throw new Error('information_asset_capture_preset_missing');
  assertReadOnlyServiceCapture(
    request.service_id,
    request.action,
    preset.operations[request.action]
  );
  await verify();
  const capability = Object.freeze({});
  admissions.set(capability, {
    requestSnapshot: snapshot(request),
    presetSnapshot: presetSnapshot(preset, request.action),
    endpointSnapshot: snapshot(config),
    expires: Date.now() + 30000,
    verify,
  });
  return capability;
}
export async function consumeScopedServiceCaptureAdmission(
  capability: object,
  serviceId: string,
  action: string,
  params: unknown,
  preset: ServicePresetRecord,
  serviceConfig?: ResolvedServiceEndpointRecord
): Promise<ScopedServiceCaptureTransport> {
  const entry = admissions.get(capability);
  admissions.delete(capability);
  if (
    !entry ||
    getPluginExecutionContext() ||
    entry.expires < Date.now() ||
    entry.requestSnapshot !== snapshot({ service_id: serviceId, action, params }) ||
    entry.presetSnapshot !== presetSnapshot(preset, action) ||
    entry.endpointSnapshot !==
      snapshot(serviceConfig ?? loadServiceEndpointsCatalog().services[serviceId])
  )
    throw new Error('information_asset_capture_admission_denied');
  assertReadOnlyServiceCapture(serviceId, action, preset.operations[action]);
  const request = { service_id: serviceId, action, params: params as Record<string, unknown> };
  assertCaptureRequest(request);
  const transport = await entry.verify();
  const validate = transport.validate;
  transport.validate = () => {
    assertCaptureRequest(request);
    validate?.();
  };
  if (
    transport.binding.serviceId !== serviceId ||
    !['none', 'secret-guard', 'session'].includes(transport.binding.authMode)
  )
    throw new Error('information_asset_capture_binding_invalid');
  return transport;
}
