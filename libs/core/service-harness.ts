import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { safeMkdir, safeWriteFile } from './secure-io.js';
import { getServicePresetRecord, type ServicePresetRecord } from './service-preset-registry.js';
import { loadServiceEndpointsCatalog } from './service-binding.js';
import { pathResolver } from './path-resolver.js';

export type ServiceOperationRisk = 'read' | 'write' | 'destructive';
export type ServiceOperationKind = 'capture' | 'apply';
export type ServiceIdempotency = 'not_applicable' | 'recommended' | 'required';

export type ServiceVerificationSpec = {
  kind: 'result_present' | 'non_empty' | 'field_present' | 'field_equals';
  path?: string;
  expected?: unknown;
};

export type ServiceOperationAlternativeSummary = {
  type: string;
  method?: string;
  path?: string;
  command?: string;
  url?: string;
};

export type ServiceOperationContract = {
  action: string;
  description?: string;
  kind: ServiceOperationKind;
  risk: ServiceOperationRisk;
  approval_required: boolean;
  idempotency: ServiceIdempotency;
  parameters: Record<string, Record<string, unknown>>;
  alternatives: ServiceOperationAlternativeSummary[];
  verification: ServiceVerificationSpec;
};

export type ServiceHarnessDescriptor = {
  kind: 'service-harness-descriptor.v1';
  service_id: string;
  display_name: string;
  description?: string;
  auth_strategy?: string;
  setup_hint?: string;
  operation_count: number;
  operations: ServiceOperationContract[];
};

export type ServiceOperationPlan = {
  kind: 'service-operation-plan.v1';
  plan_id: string;
  created_at: string;
  service_id: string;
  action: string;
  risk: ServiceOperationRisk;
  kind_of_operation: ServiceOperationKind;
  approval_required: boolean;
  idempotency: ServiceIdempotency;
  inputs: Record<string, unknown>;
  selected_route: ServiceOperationAlternativeSummary | null;
  alternatives: ServiceOperationAlternativeSummary[];
  verification: ServiceVerificationSpec;
  valid: boolean;
  validation_errors: string[];
};

export type ServiceVerificationResult = {
  status: 'passed' | 'failed';
  kind: ServiceVerificationSpec['kind'];
  reason: string;
};

export type ServiceExecutionReceipt = {
  kind: 'service-execution-receipt.v1';
  receipt_id: string;
  created_at: string;
  plan_id: string;
  service_id: string;
  action: string;
  risk: ServiceOperationRisk;
  approval_required: boolean;
  selected_route: ServiceOperationAlternativeSummary | null;
  inputs: Record<string, unknown>;
  status: 'succeeded' | 'failed' | 'approval_required';
  verification: ServiceVerificationResult;
  result_summary: Record<string, unknown>;
  error?: string;
  receipt_path?: string;
};

const SENSITIVE_KEY =
  /(token|secret|password|authorization|api[_-]?key|credential|cookie|private[_-]?key)/iu;
const RECEIPT_DIR = pathResolver.shared('runtime/service-receipts');

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function inferRisk(
  operation: Record<string, unknown>,
  alternatives: ServiceOperationAlternativeSummary[]
): ServiceOperationRisk {
  const declared = operation.risk;
  if (declared === 'read' || declared === 'write' || declared === 'destructive') return declared;
  const method = String(operation.method || alternatives[0]?.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (method === 'DELETE') return 'destructive';
  return 'write';
}

function inferKind(
  operation: Record<string, unknown>,
  risk: ServiceOperationRisk
): ServiceOperationKind {
  if (operation.kind === 'capture' || operation.kind === 'apply') return operation.kind;
  return risk === 'read' ? 'capture' : 'apply';
}

function inferIdempotency(
  operation: Record<string, unknown>,
  risk: ServiceOperationRisk
): ServiceIdempotency {
  if (
    operation.idempotency === 'not_applicable' ||
    operation.idempotency === 'recommended' ||
    operation.idempotency === 'required'
  ) {
    return operation.idempotency;
  }
  return risk === 'read' ? 'not_applicable' : 'recommended';
}

function normalizeAlternative(
  value: unknown,
  fallback: Record<string, unknown>
): ServiceOperationAlternativeSummary {
  const alternative = recordOrEmpty(value);
  const type = String(alternative.type || fallback.type || 'api');
  const summary: ServiceOperationAlternativeSummary = { type };
  const method = alternative.method || fallback.method;
  const pathValue = alternative.path || fallback.path;
  const command = alternative.command || fallback.command;
  const url = alternative.url || fallback.url;
  if (method) summary.method = String(method).toUpperCase();
  if (pathValue) summary.path = String(pathValue);
  if (command) summary.command = String(command);
  if (url) summary.url = String(url);
  return summary;
}

function normalizeVerification(value: unknown): ServiceVerificationSpec {
  const candidate = recordOrEmpty(value);
  const kind = candidate.kind;
  if (
    kind === 'result_present' ||
    kind === 'non_empty' ||
    kind === 'field_present' ||
    kind === 'field_equals'
  ) {
    return {
      kind,
      ...(typeof candidate.path === 'string' ? { path: candidate.path } : {}),
      ...(Object.prototype.hasOwnProperty.call(candidate, 'expected')
        ? { expected: candidate.expected }
        : {}),
    };
  }
  return { kind: 'result_present' };
}

function normalizeOperation(action: string, raw: unknown): ServiceOperationContract {
  const operation = recordOrEmpty(raw);
  const rawAlternatives =
    Array.isArray(operation.alternatives) && operation.alternatives.length > 0
      ? operation.alternatives
      : [operation];
  const alternatives = rawAlternatives.map((alternative) =>
    normalizeAlternative(alternative, operation)
  );
  const risk = inferRisk(operation, alternatives);
  const parameters = recordOrEmpty(operation.parameters) as Record<string, Record<string, unknown>>;
  return {
    action,
    ...(typeof operation.description === 'string' ? { description: operation.description } : {}),
    kind: inferKind(operation, risk),
    risk,
    approval_required:
      typeof operation.approval_required === 'boolean'
        ? operation.approval_required
        : risk !== 'read',
    idempotency: inferIdempotency(operation, risk),
    parameters,
    alternatives,
    verification: normalizeVerification(operation.verification),
  };
}

function loadHarnessPreset(serviceId: string): {
  preset: ServicePresetRecord;
  endpoint: Record<string, unknown>;
} {
  const endpoints = loadServiceEndpointsCatalog();
  const endpoint = recordOrEmpty(endpoints.services?.[serviceId]);
  const preset = getServicePresetRecord(
    serviceId,
    typeof endpoint.preset_path === 'string' ? endpoint.preset_path : undefined
  );
  if (!preset) throw new Error(`No service preset found for: ${serviceId}`);
  return { preset, endpoint };
}

export function describeServiceHarness(
  serviceId: string,
  options: { detail?: boolean } = {}
): ServiceHarnessDescriptor {
  const normalizedServiceId = serviceId.trim();
  if (!normalizedServiceId) throw new Error('service_id is required');
  const { preset, endpoint } = loadHarnessPreset(normalizedServiceId);
  const allOperations = Object.entries(preset.operations || {}).map(([action, operation]) =>
    normalizeOperation(action, operation)
  );
  const operations =
    options.detail === false
      ? allOperations.map((operation) => ({
          ...operation,
          parameters: {},
          alternatives: operation.alternatives.map(({ type, method }) => ({
            type,
            ...(method ? { method } : {}),
          })),
        }))
      : allOperations;
  return {
    kind: 'service-harness-descriptor.v1',
    service_id: normalizedServiceId,
    display_name: String(endpoint.display_name || preset.name || normalizedServiceId),
    ...(typeof preset.description === 'string' ? { description: preset.description } : {}),
    ...(typeof preset.auth_strategy === 'string' ? { auth_strategy: preset.auth_strategy } : {}),
    ...(typeof preset.setup_hint === 'string' ? { setup_hint: preset.setup_hint } : {}),
    operation_count: allOperations.length,
    operations,
  };
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_KEY.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ])
    );
  }
  if (typeof value === 'string' && value.length > 240) return `${value.slice(0, 237)}...`;
  return value;
}

function redactError(error: string): string {
  return error
    .replace(/Bearer\s+[^\s]+/giu, 'Bearer [REDACTED]')
    .replace(/((?:token|secret|password|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu, '$1[REDACTED]')
    .slice(0, 500);
}

export function redactServiceInputs(value: unknown): Record<string, unknown> {
  return recordOrEmpty(redactValue(value));
}

function validateParameterValue(
  name: string,
  value: unknown,
  definition: Record<string, unknown>
): string | null {
  const expected = typeof definition.type === 'string' ? definition.type : undefined;
  if (!expected) return null;
  const valid =
    expected === 'string'
      ? typeof value === 'string'
      : expected === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : expected === 'integer'
          ? typeof value === 'number' && Number.isInteger(value)
          : expected === 'boolean'
            ? typeof value === 'boolean'
            : expected === 'array'
              ? Array.isArray(value)
              : expected === 'object'
                ? value !== null && typeof value === 'object' && !Array.isArray(value)
                : true;
  return valid ? null : `${name} must be ${expected}`;
}

export function validateServiceOperationInputs(
  operation: ServiceOperationContract,
  inputs: Record<string, unknown>
): string[] {
  const errors: string[] = [];
  for (const [name, definition] of Object.entries(operation.parameters)) {
    const hasValue = Object.prototype.hasOwnProperty.call(inputs, name);
    if (
      !hasValue &&
      definition.required === true &&
      !Object.prototype.hasOwnProperty.call(definition, 'default')
    ) {
      errors.push(`${name} is required`);
      continue;
    }
    if (hasValue) {
      const error = validateParameterValue(name, inputs[name], definition);
      if (error) errors.push(error);
    }
  }
  return errors;
}

export function planServiceOperation(
  serviceId: string,
  action: string,
  inputs: Record<string, unknown> = {}
): ServiceOperationPlan {
  const descriptor = describeServiceHarness(serviceId, { detail: true });
  const operation = descriptor.operations.find((candidate) => candidate.action === action);
  if (!operation) throw new Error(`Operation "${action}" not found for service ${serviceId}`);
  const normalizedInputs =
    inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? inputs : {};
  const validationErrors = validateServiceOperationInputs(operation, normalizedInputs);
  return {
    kind: 'service-operation-plan.v1',
    plan_id: `PLN-SVC-${randomUUID()}`,
    created_at: new Date().toISOString(),
    service_id: descriptor.service_id,
    action,
    risk: operation.risk,
    kind_of_operation: operation.kind,
    approval_required: operation.approval_required,
    idempotency: operation.idempotency,
    inputs: redactServiceInputs(normalizedInputs),
    selected_route: operation.alternatives[0] || null,
    alternatives: operation.alternatives,
    verification: operation.verification,
    valid: validationErrors.length === 0,
    validation_errors: validationErrors,
  };
}

function readPath(value: unknown, pathValue: string): unknown {
  return pathValue
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (!current || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[segment];
    }, value);
}

export function verifyServiceOperationResult(
  operation: ServiceOperationContract,
  result: unknown
): ServiceVerificationResult {
  const verification = operation.verification;
  if (verification.kind === 'result_present') {
    return result === undefined || result === null
      ? { status: 'failed', kind: verification.kind, reason: 'result is missing' }
      : { status: 'passed', kind: verification.kind, reason: 'result is present' };
  }
  if (verification.kind === 'non_empty') {
    const nonEmpty =
      typeof result === 'string'
        ? result.length > 0
        : Array.isArray(result)
          ? result.length > 0
          : result !== null && typeof result === 'object'
            ? Object.keys(result).length > 0
            : result !== undefined && result !== null;
    return nonEmpty
      ? { status: 'passed', kind: verification.kind, reason: 'result is non-empty' }
      : { status: 'failed', kind: verification.kind, reason: 'result is empty' };
  }
  const actual = verification.path ? readPath(result, verification.path) : undefined;
  if (verification.kind === 'field_present') {
    return actual === undefined || actual === null
      ? {
          status: 'failed',
          kind: verification.kind,
          reason: `field ${verification.path || '(missing path)'} is missing`,
        }
      : {
          status: 'passed',
          kind: verification.kind,
          reason: `field ${verification.path} is present`,
        };
  }
  const matches = JSON.stringify(actual) === JSON.stringify(verification.expected);
  return matches
    ? {
        status: 'passed',
        kind: verification.kind,
        reason: `field ${verification.path} matches expected value`,
      }
    : {
        status: 'failed',
        kind: verification.kind,
        reason: `field ${verification.path} does not match expected value`,
      };
}

function summarizeResult(result: unknown): Record<string, unknown> {
  if (result === null) return { type: 'null' };
  if (result === undefined) return { type: 'undefined' };
  if (Array.isArray(result)) return { type: 'array', length: result.length };
  if (typeof result === 'object') {
    return { type: 'object', keys: Object.keys(result as Record<string, unknown>).slice(0, 32) };
  }
  return { type: typeof result };
}

export function createServiceExecutionReceipt(
  plan: ServiceOperationPlan,
  result: unknown,
  options: {
    status?: ServiceExecutionReceipt['status'];
    error?: string;
  } = {}
): ServiceExecutionReceipt {
  const operation = describeServiceHarness(plan.service_id, { detail: true }).operations.find(
    (candidate) => candidate.action === plan.action
  );
  if (!operation)
    throw new Error(`Operation "${plan.action}" not found for service ${plan.service_id}`);
  const status = options.status || 'succeeded';
  return {
    kind: 'service-execution-receipt.v1',
    receipt_id: `RCP-SVC-${randomUUID()}`,
    created_at: new Date().toISOString(),
    plan_id: plan.plan_id,
    service_id: plan.service_id,
    action: plan.action,
    risk: plan.risk,
    approval_required: plan.approval_required,
    selected_route: plan.selected_route,
    inputs: redactServiceInputs(plan.inputs),
    status,
    verification: verifyServiceOperationResult(operation, result),
    result_summary: summarizeResult(result),
    ...(options.error ? { error: redactError(options.error) } : {}),
  };
}

export function persistServiceExecutionReceipt(
  receipt: ServiceExecutionReceipt
): ServiceExecutionReceipt {
  safeMkdir(RECEIPT_DIR, { recursive: true });
  const safeId = receipt.receipt_id.replace(/[^a-zA-Z0-9._-]/g, '_');
  const receiptPath = path.join(RECEIPT_DIR, `${safeId}.json`);
  safeWriteFile(receiptPath, JSON.stringify(receipt, null, 2));
  return { ...receipt, receipt_path: receiptPath };
}
