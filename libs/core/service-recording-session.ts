import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import {
  describeServiceHarness,
  planServiceOperation,
  type ServiceOperationContract,
} from './service-harness.js';
import {
  validateServiceRecording,
  type ServiceRecording,
  type ServiceRecordingStep,
} from './service-recording.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeMkdir, safeWriteFile } from './secure-io.js';

export type ServiceRecordedParameterKind = 'fixed' | 'input' | 'template' | 'secret';

export interface ServiceCallObservation {
  service_id: string;
  action: string;
  params?: Record<string, unknown>;
  result?: unknown;
  summary?: string;
  produces?: string;
  consumes?: string[];
}

export interface ServiceRecordingSessionOptions {
  target_name: string;
  services?: string[];
  recording_id?: string;
  now?: () => string;
}

export interface RecordedServiceCall extends ServiceCallObservation {
  operation: ServiceOperationContract;
  plan_validation_errors: string[];
}

const SECRET_KEY =
  /(token|secret|password|authorization|api[_-]?key|credential|cookie|private[_-]?key|otp|one[_-]?time|passphrase)/iu;
const RECORDING_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const INPUT_RE = /^\{\{input\.([a-z][a-z0-9_]{0,63})\}\}$/u;
const TEMPLATE_RE = /^\{\{(?:channel|secret)\.[^}]+\}\}$/u;

function parameterKind(value: unknown, key: string): ServiceRecordedParameterKind {
  if (SECRET_KEY.test(key)) return 'secret';
  if (typeof value === 'string' && INPUT_RE.test(value)) return 'input';
  if (typeof value === 'string' && TEMPLATE_RE.test(value)) return 'template';
  return 'fixed';
}

function safeParameterPath(path: string): string {
  return path.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 160) || 'value';
}

function sanitizeParams(
  value: unknown,
  path = '',
  bindings: Record<string, ServiceRecordedParameterKind> = {},
  secretRefs: string[] = []
): {
  value: unknown;
  bindings: Record<string, ServiceRecordedParameterKind>;
  secret_refs: string[];
} {
  if (Array.isArray(value)) {
    return value.reduce(
      (state, item, index) => {
        const child = sanitizeParams(
          item,
          `${path}.${index}`.replace(/^\./, ''),
          state.bindings,
          state.secret_refs
        );
        state.value.push(child.value);
        return state;
      },
      { value: [] as unknown[], bindings, secret_refs: secretRefs }
    );
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, childValue] of Object.entries(value)) {
      const childPath = safeParameterPath(path ? `${path}.${key}` : key);
      const kind = parameterKind(childValue, key);
      bindings[childPath] = kind;
      if (kind === 'secret') {
        output[key] = `{{secret.${childPath}}}`;
        secretRefs.push(childPath);
      } else {
        const child = sanitizeParams(childValue, childPath, bindings, secretRefs);
        output[key] = child.value;
      }
    }
    return { value: output, bindings, secret_refs: [...new Set(secretRefs)] };
  }
  return { value, bindings, secret_refs: [...new Set(secretRefs)] };
}

function summarizeResult(result: unknown): NonNullable<ServiceRecordingStep['result_summary']> {
  if (result === null || result === undefined) return { kind: 'null' };
  if (Array.isArray(result)) return { kind: 'array', array_length: result.length };
  if (typeof result === 'object') {
    return { kind: 'object', keys: Object.keys(result as Record<string, unknown>).slice(0, 50) };
  }
  return { kind: typeof result as 'string' | 'number' | 'boolean' };
}

function operationFor(serviceId: string, action: string): ServiceOperationContract {
  const descriptor = describeServiceHarness(serviceId, { detail: true });
  const operation = descriptor.operations.find((candidate) => candidate.action === action);
  if (!operation) throw new Error(`Operation "${action}" not found for service ${serviceId}`);
  return operation;
}

function riskClass(operation: ServiceOperationContract): ServiceRecordingStep['risk_class'] {
  return operation.risk === 'read' ? 'read' : 'high';
}

/**
 * In-process recorder for canonical service:preset calls. It records the
 * operation contract and bounded result shape, never the raw result. Secret
 * parameter values become explicit bindings that require human review.
 */
export class ServiceRecordingSession {
  readonly recording_id: string;
  private readonly now: () => string;
  private readonly targetName: string;
  private readonly services = new Set<string>();
  private readonly steps: ServiceRecordingStep[] = [];

  constructor(options: ServiceRecordingSessionOptions) {
    if (!options.target_name.trim()) throw new Error('target_name is required');
    this.recording_id = options.recording_id?.trim() || `svc-rec-${randomUUID()}`;
    if (!RECORDING_ID_RE.test(this.recording_id)) {
      throw new Error(
        'recording_id must contain only letters, numbers, dot, underscore, or hyphen'
      );
    }
    this.now = options.now || (() => new Date().toISOString());
    this.targetName = options.target_name.trim();
    for (const service of options.services || []) this.services.add(service);
  }

  recordCall(input: ServiceCallObservation): RecordedServiceCall {
    const operation = operationFor(input.service_id, input.action);
    const originalParams = input.params && typeof input.params === 'object' ? input.params : {};
    const plan = planServiceOperation(input.service_id, input.action, originalParams);
    const sanitized = sanitizeParams(originalParams);
    const step: ServiceRecordingStep = {
      step_id: `step-${String(this.steps.length + 1).padStart(3, '0')}`,
      service_id: input.service_id,
      action: input.action,
      summary: (
        input.summary ||
        operation.description ||
        `${input.service_id}:${input.action}`
      ).slice(0, 500),
      risk_class: riskClass(operation),
      params: sanitized.value as Record<string, unknown>,
      ...(Object.keys(sanitized.bindings).length > 0 ? { param_bindings: sanitized.bindings } : {}),
      ...(sanitized.secret_refs.length > 0 ? { secret_refs: sanitized.secret_refs } : {}),
      ...(input.produces ? { produces: input.produces } : {}),
      ...(input.consumes?.length ? { consumes: [...input.consumes] } : {}),
      ...(input.result !== undefined ? { result_summary: summarizeResult(input.result) } : {}),
      ...(plan.validation_errors.length > 0 ? { validation_errors: plan.validation_errors } : {}),
    };
    this.services.add(input.service_id);
    this.steps.push(step);
    return { ...input, operation, plan_validation_errors: plan.validation_errors };
  }

  toRecording(): ServiceRecording {
    const recording: ServiceRecording = {
      schema_version: 'service-recording.v1',
      recording_id: this.recording_id,
      source: 'service-capture',
      created_at: this.now(),
      target: { name: this.targetName, services: [...this.services] },
      steps: this.steps.map((step) => ({ ...step })),
      risk_summary: {
        requires_manual_review: true,
        approval_required_count: this.steps.filter((step) => step.risk_class === 'high').length,
      },
      review: {
        status: 'pending',
        decisions: this.steps.map((step) => ({ step_id: step.step_id, status: 'pending' })),
      },
    };
    const validation = validateServiceRecording(recording);
    if (!validation.value)
      throw new Error(`Invalid service recording: ${validation.errors.join('; ')}`);
    return validation.value;
  }

  persist(): string {
    const recording = this.toRecording();
    const dir = assertSafeRepositoryPath(pathResolver.shared('runtime/recordings'), {
      allowMissingLeaf: true,
    });
    safeMkdir(dir, { recursive: true });
    const recordingPath = assertSafeRepositoryPath(path.join(dir, `${this.recording_id}.json`), {
      allowMissingLeaf: true,
    });
    safeWriteFile(recordingPath, `${JSON.stringify(recording, null, 2)}\n`);
    return pathResolver.toRepoRelative(recordingPath);
  }
}

const activeSessions = new Map<string, ServiceRecordingSession>();

export function startServiceRecordingSession(
  options: ServiceRecordingSessionOptions
): ServiceRecordingSession {
  const session = new ServiceRecordingSession(options);
  activeSessions.set(session.recording_id, session);
  return session;
}

export function getServiceRecordingSession(
  id: string | undefined
): ServiceRecordingSession | undefined {
  return id ? activeSessions.get(id) : undefined;
}

export function stopServiceRecordingSession(id: string): ServiceRecordingSession | undefined {
  const session = activeSessions.get(id);
  activeSessions.delete(id);
  return session;
}

export function recordServiceCall(
  sessionId: string | undefined,
  input: ServiceCallObservation
): RecordedServiceCall | undefined {
  const session = getServiceRecordingSession(sessionId);
  return session?.recordCall(input);
}
