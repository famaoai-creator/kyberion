import { createHash } from 'node:crypto';
import type { ValidateFunction } from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { pathResolver } from './path-resolver.js';
import { loadJson, safeReadFile } from './secure-io.js';
import { createAjv } from './foundation/ajv.js';

const ajv = createAjv();
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
addFormats(ajv);

const SCHEMA_PATH = pathResolver.knowledge('product/schemas/service-recording.schema.json');

/** A single recorded service:preset call. */
export interface ServiceRecordingStep {
  step_id: string;
  service_id: string;
  action: string;
  summary: string;
  /** `read` = no side effect; `high` = external effect (create/update/delete/post…) → approval. */
  risk_class: 'read' | 'low' | 'high';
  /** Literals or `{{input.NAME}}` / `{{channel.NAME}}` placeholders. Never secret values. */
  params?: Record<string, unknown>;
  /** Channel name this step's result is published under (for later `consumes`). */
  produces?: string;
  /** Channel names this step reads from prior steps. */
  consumes?: string[];
  /** Classification of each recorded parameter path; raw secrets are never persisted. */
  param_bindings?: Record<string, 'fixed' | 'input' | 'template' | 'secret'>;
  /** Parameter paths that require a human to bind a secret before execution. */
  secret_refs?: string[];
  /** Bounded result shape used for review and Golden Scenario extraction. */
  result_summary?: {
    kind: 'null' | 'string' | 'number' | 'boolean' | 'object' | 'array';
    keys?: string[];
    array_length?: number;
  };
  /** Validation findings captured at observation time; never a reason to execute. */
  validation_errors?: string[];
}

export interface ServiceRecording {
  schema_version: 'service-recording.v1';
  recording_id: string;
  source: 'service-capture';
  created_at: string;
  target: { name: string; services: string[] };
  steps: ServiceRecordingStep[];
  risk_summary: { requires_manual_review: boolean; approval_required_count: number };
  review?: {
    status: 'pending' | 'in_review' | 'approved' | 'rejected';
    reviewer?: string;
    reviewed_at?: string;
    note?: string;
    /** SHA-256 of the recording content excluding the review envelope. */
    content_hash?: string;
    decisions: Array<{
      step_id: string;
      status: 'pending' | 'approved' | 'rejected';
      reason?: string;
    }>;
  };
}

let validator: ValidateFunction | null = null;
function getValidator(): ValidateFunction {
  if (!validator) {
    validator = ajv.compile(loadJson<Record<string, unknown>>(SCHEMA_PATH));
  }
  return validator;
}

/** A step has an external effect (must pass the approval gate) iff risk_class is high. */
export function isExternalEffectStep(step: ServiceRecordingStep): boolean {
  return step.risk_class === 'high';
}

/** Bind an approval to the exact effect plan that was reviewed. */
export function serviceRecordingContentHash(recording: ServiceRecording): string {
  const { review: _review, ...content } = recording;
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

const INPUT_PLACEHOLDER = /\{\{input\.([a-z][a-z0-9_]{0,63})\}\}/g;
const CHANNEL_PLACEHOLDER = /\{\{channel\.([a-zA-Z0-9_]+)\}\}/g;
const SECRET_PLACEHOLDER = /^\{\{secret\.([a-zA-Z0-9_.-]+)\}\}$/u;
const SENSITIVE_KEY =
  /(token|secret|password|authorization|api[_-]?key|credential|cookie|private[_-]?key|otp|one[_-]?time|passphrase)/iu;

/** Collect distinct `{{input.NAME}}` placeholders referenced across all steps. */
export function collectServiceInputNames(recording: ServiceRecording): string[] {
  const names = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === 'string') {
      for (const m of value.matchAll(INPUT_PLACEHOLDER)) names.add(m[1]);
    } else if (Array.isArray(value)) {
      value.forEach(scan);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(scan);
    }
  };
  for (const step of recording.steps) scan(step.params ?? {});
  return [...names];
}

/** Validate a service recording against the schema + structural invariants. */
export function validateServiceRecording(input: unknown): {
  valid: boolean;
  errors: string[];
  value?: ServiceRecording;
} {
  const validate = getValidator();
  if (!validate(input)) {
    return {
      valid: false,
      errors: (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`),
    };
  }
  const recording = input as ServiceRecording;
  const errors: string[] = [];

  const highRisk = recording.steps.filter(isExternalEffectStep);
  if (!recording.risk_summary.requires_manual_review)
    errors.push('service recordings must require manual review');
  if (recording.risk_summary.approval_required_count !== highRisk.length) {
    errors.push(
      'risk_summary.approval_required_count must match high-risk (external-effect) steps'
    );
  }

  const stepIds = new Set<string>();
  const produced = new Set<string>();
  for (const step of recording.steps) {
    if (stepIds.has(step.step_id)) errors.push(`duplicate step_id ${step.step_id}`);
    stepIds.add(step.step_id);
    if (!recording.target.services.includes(step.service_id)) {
      errors.push(`step ${step.step_id} uses service "${step.service_id}" not in target.services`);
    }
    // consumes must reference a channel produced by an earlier step (ordering).
    for (const channel of step.consumes ?? []) {
      if (!produced.has(channel))
        errors.push(`step ${step.step_id} consumes channel "${channel}" before it is produced`);
    }
    if (step.produces) produced.add(step.produces);
    const scanParams = (value: unknown, path = ''): void => {
      if (Array.isArray(value)) {
        value.forEach((item, index) => scanParams(item, `${path}.${index}`));
        return;
      }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        if (SENSITIVE_KEY.test(key)) {
          if (typeof child !== 'string' || !SECRET_PLACEHOLDER.test(child)) {
            errors.push(
              `step ${step.step_id} contains an unbound sensitive parameter: ${childPath}`
            );
          }
        }
        scanParams(child, childPath);
      }
    };
    scanParams(step.params);
  }
  if (recording.review) {
    const stepIds = new Set(recording.steps.map((step) => step.step_id));
    const reviewedIds = new Set<string>();
    for (const decision of recording.review.decisions) {
      if (!stepIds.has(decision.step_id)) {
        errors.push(`review decision references unknown step ${decision.step_id}`);
      }
      if (reviewedIds.has(decision.step_id)) {
        errors.push(`review contains duplicate decision for ${decision.step_id}`);
      }
      reviewedIds.add(decision.step_id);
    }
    if (recording.review.status === 'approved') {
      if (recording.review.content_hash !== serviceRecordingContentHash(recording)) {
        errors.push('approved review content_hash does not match the recording content');
      }
      const missing = recording.steps
        .filter((step) => !reviewedIds.has(step.step_id))
        .map((step) => step.step_id);
      if (missing.length > 0) {
        errors.push(`approved review is missing decisions for: ${missing.join(', ')}`);
      }
      if (recording.review.decisions.some((d) => d.status !== 'approved')) {
        errors.push('approved review cannot contain pending or rejected decisions');
      }
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, errors: [], value: recording };
}
