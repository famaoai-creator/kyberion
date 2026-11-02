/** Internal exact-request, single-use scoped read admission. No domain-layer imports belong here. */
import { createHash } from 'node:crypto';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import {
  loadServiceEndpointsCatalog,
  type ResolvedServiceEndpointRecord,
} from './service-endpoint-registry.js';
import { getServicePresetRecord, type ServicePresetRecord } from './service-preset-registry.js';
import type { ServiceBinding } from './service-binding.js';
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
  requestHash: string;
  presetHash: string;
  endpointHash: string;
  expires: number;
  verify: () => Promise<ScopedServiceCaptureTransport>;
}
const admissions = new WeakMap<object, Admission>();
function hash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}
function presetHash(preset: ServicePresetRecord, action: string): string {
  const { operations: _operations, ...configuration } = preset;
  return hash({ configuration, operation: preset.operations[action] });
}
export function assertReadOnlyServiceCapture(
  service: string,
  action: string,
  rawOperation?: unknown
): void {
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
  if (operation.type !== 'cli' && !['GET', 'HEAD'].includes(String(operation.method).toUpperCase()))
    throw new Error('information_asset_capture_http_method_denied');
}
export async function issueScopedServiceCaptureAdmission(
  request: ScopedServiceCaptureRequest,
  verify: () => Promise<ScopedServiceCaptureTransport>
): Promise<object> {
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
    requestHash: hash(request),
    presetHash: presetHash(preset, request.action),
    endpointHash: hash(config),
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
    entry.requestHash !== hash({ service_id: serviceId, action, params }) ||
    entry.presetHash !== presetHash(preset, action) ||
    entry.endpointHash !== hash(serviceConfig ?? loadServiceEndpointsCatalog().services[serviceId])
  )
    throw new Error('information_asset_capture_admission_denied');
  assertReadOnlyServiceCapture(serviceId, action, preset.operations[action]);
  const transport = await entry.verify();
  if (
    transport.binding.serviceId !== serviceId ||
    !['none', 'secret-guard', 'session'].includes(transport.binding.authMode)
  )
    throw new Error('information_asset_capture_binding_invalid');
  return transport;
}
