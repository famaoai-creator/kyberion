import AjvModule, { type ValidateFunction } from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { createHash } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
addFormats(ajv);

const RECORDING_SCHEMA_PATH = pathResolver.knowledge('product/schemas/browser-recording.schema.json');
const SESSION_SCHEMA_PATH = pathResolver.knowledge('product/schemas/browser-extension-session.schema.json');
const RECEIPT_SCHEMA_PATH = pathResolver.knowledge('product/schemas/browser-extension-receipt.schema.json');

const HIGH_RISK_OPERATIONS = new Set<BrowserExtensionOperation>([
  'submit_form',
  'upload_file',
  'download_file',
  'delete',
  'purchase',
  'credential_submit',
  'settings_change',
]);

export type BrowserExtensionOperation =
  | 'snapshot'
  | 'screenshot'
  | 'extract_text_ref'
  | 'list_tabs'
  | 'open_tab'
  | 'select_tab'
  | 'click_ref'
  | 'fill_ref'
  | 'select_ref'
  | 'press_ref'
  | 'wait_for_ref'
  | 'submit_form'
  | 'upload_file'
  | 'download_file'
  | 'delete'
  | 'purchase'
  | 'credential_submit'
  | 'settings_change'
  | 'sensitive_input_omitted';

export interface BrowserExtensionAction {
  action_id: string;
  op: BrowserExtensionOperation;
  summary: string;
  risk: 'observe' | 'low' | 'high' | 'sensitive';
  captured_at: string;
  target?: {
    ref: string;
    role: string;
    name: string;
    snapshot_hash: string;
  };
  variable?: {
    name: string;
    classification: 'user_input' | 'secret_ref';
  };
  selection?: {
    kind: 'option' | 'toggle';
    label?: string;
    checked?: boolean;
  };
}

export interface BrowserExtensionRecording {
  schema_version: 'browser-recording.v1';
  recording_id: string;
  source: 'chrome-extension';
  created_at: string;
  tab: {
    origin: string;
    origin_hash: string;
    title: string;
  };
  extension: { version: string };
  actions: BrowserExtensionAction[];
  risk_summary: {
    requires_manual_review: boolean;
    sensitive_input_omitted: number;
    approval_required_count: number;
  };
  review?: {
    status: 'pending' | 'in_review' | 'approved' | 'rejected';
    reviewed_at?: string;
    decisions: Array<{
      action_id: string;
      status: 'pending' | 'approved' | 'rejected';
      reason?: string;
    }>;
  };
}

export interface BrowserExtensionSessionRequest {
  kind: 'browser-extension-session.v1';
  mission_id: string;
  pipeline_id: string;
  tab_id: string;
  origin: string;
  mode: 'observe' | 'record' | 'execute';
  recording_id: string;
  requested_operations: Exclude<BrowserExtensionOperation, 'sensitive_input_omitted'>[];
  lease?: {
    lease_id: string;
    issued_at: string;
    expires_at: string;
    approved_step_hashes: string[];
  };
}

export interface BrowserExtensionReceipt {
  kind: 'browser-extension-receipt.v1';
  receipt_id: string;
  mission_id: string;
  pipeline_id: string;
  recording_id: string;
  tab_id: string;
  origin: string;
  status: 'completed' | 'blocked' | 'failed' | 'cancelled';
  approval_rule_id?: string;
  lease_id?: string;
  evidence_refs?: string[];
  summary?: string;
  created_at: string;
}

export interface BrowserExtensionValidationResult<T> {
  valid: boolean;
  errors: string[];
  value?: T;
}

export interface BrowserExtensionPreflightResult {
  status: 'ready_for_review' | 'approval_required' | 'blocked';
  errors: string[];
  approvalRequired: boolean;
  approvedStepHashes: string[];
}

let recordingValidator: ValidateFunction | null = null;
let sessionValidator: ValidateFunction | null = null;
let receiptValidator: ValidateFunction | null = null;

function schemaValidator(schemaPath: string, cached: ValidateFunction | null): ValidateFunction {
  if (cached) return cached;
  return ajv.compile(JSON.parse(safeReadFile(schemaPath, { encoding: 'utf8' }) as string));
}

function formatErrors(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim(),
  );
}

function canonicalOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

function validateRecordingSemantics(recording: BrowserExtensionRecording): string[] {
  const errors: string[] = [];
  const highRiskActions = recording.actions.filter((action) => HIGH_RISK_OPERATIONS.has(action.op));
  const omittedSensitiveActions = recording.actions.filter((action) => action.op === 'sensitive_input_omitted');

  if (!canonicalOrigin(recording.tab.origin)) errors.push('recording tab.origin must be an http(s) origin');
  if (!recording.risk_summary.requires_manual_review) errors.push('recordings must require manual review');
  if (recording.risk_summary.approval_required_count !== highRiskActions.length) {
    errors.push('risk_summary.approval_required_count must match high-risk actions');
  }
  if (recording.risk_summary.sensitive_input_omitted !== omittedSensitiveActions.length) {
    errors.push('risk_summary.sensitive_input_omitted must match omitted sensitive inputs');
  }

  for (const action of recording.actions) {
    if (HIGH_RISK_OPERATIONS.has(action.op) && action.risk !== 'high') {
      errors.push(`action ${action.action_id} must be classified high risk`);
    }
    if (action.op === 'sensitive_input_omitted' && action.risk !== 'sensitive') {
      errors.push(`action ${action.action_id} must be classified sensitive`);
    }
    if (action.op === 'fill_ref' && !action.variable) {
      errors.push(`action ${action.action_id} must use a variable instead of a recorded value`);
    }
    if (action.op === 'select_ref' && !action.selection) {
      errors.push(`action ${action.action_id} must include a selection state`);
    }
    if (action.selection && action.op !== 'select_ref') {
      errors.push(`action ${action.action_id} cannot attach a selection state to ${action.op}`);
    }
  }
  if (recording.review) {
    const actionIds = new Set(recording.actions.map((action) => action.action_id));
    const reviewedIds = new Set<string>();
    for (const decision of recording.review.decisions) {
      if (!actionIds.has(decision.action_id)) errors.push(`review decision references unknown action ${decision.action_id}`);
      if (reviewedIds.has(decision.action_id)) errors.push(`review contains duplicate decision for ${decision.action_id}`);
      reviewedIds.add(decision.action_id);
    }
    if (recording.review.status === 'approved') {
      if (recording.review.decisions.some((decision) => decision.status === 'pending')) {
        errors.push('approved review cannot contain pending decisions');
      }
      if (!recording.review.decisions.some((decision) => decision.status === 'approved')) {
        errors.push('approved review must include at least one approved action');
      }
    }
  }
  return errors;
}

function selectedRecordingActions(recording: BrowserExtensionRecording): BrowserExtensionAction[] {
  const actionable = recording.actions.filter((action) => action.op !== 'sensitive_input_omitted');
  if (recording.review?.status !== 'approved') return actionable;
  const decisions = new Map(recording.review.decisions.map((decision) => [decision.action_id, decision.status]));
  return actionable.filter((action) => decisions.get(action.action_id) === 'approved');
}

export function validateBrowserExtensionRecording(input: unknown): BrowserExtensionValidationResult<BrowserExtensionRecording> {
  recordingValidator = schemaValidator(RECORDING_SCHEMA_PATH, recordingValidator);
  if (!recordingValidator(input)) return { valid: false, errors: formatErrors(recordingValidator) };
  const value = input as BrowserExtensionRecording;
  const errors = validateRecordingSemantics(value);
  return errors.length > 0 ? { valid: false, errors } : { valid: true, errors: [], value };
}

export function validateBrowserExtensionSessionRequest(input: unknown): BrowserExtensionValidationResult<BrowserExtensionSessionRequest> {
  sessionValidator = schemaValidator(SESSION_SCHEMA_PATH, sessionValidator);
  if (!sessionValidator(input)) return { valid: false, errors: formatErrors(sessionValidator) };
  const value = input as BrowserExtensionSessionRequest;
  if (!canonicalOrigin(value.origin)) return { valid: false, errors: ['session origin must be an http(s) origin'] };
  return { valid: true, errors: [], value };
}

export function validateBrowserExtensionReceipt(input: unknown): BrowserExtensionValidationResult<BrowserExtensionReceipt> {
  receiptValidator = schemaValidator(RECEIPT_SCHEMA_PATH, receiptValidator);
  if (!receiptValidator(input)) return { valid: false, errors: formatErrors(receiptValidator) };
  const value = input as BrowserExtensionReceipt;
  if (!canonicalOrigin(value.origin)) return { valid: false, errors: ['receipt origin must be an http(s) origin'] };
  return { valid: true, errors: [], value };
}

export function hashBrowserExtensionAction(action: BrowserExtensionAction): string {
  return createHash('sha256')
    .update(JSON.stringify({
      action_id: action.action_id,
      op: action.op,
      target: action.target,
      variable: action.variable,
      selection: action.selection,
    }))
    .digest('hex');
}

export function preflightBrowserExtensionSession(input: {
  recording: unknown;
  session: unknown;
  now?: Date;
}): BrowserExtensionPreflightResult {
  const recording = validateBrowserExtensionRecording(input.recording);
  const session = validateBrowserExtensionSessionRequest(input.session);
  const errors = [...recording.errors, ...session.errors];
  if (!recording.value || !session.value) {
    return { status: 'blocked', errors, approvalRequired: false, approvedStepHashes: [] };
  }

  const recordingOrigin = canonicalOrigin(recording.value.tab.origin);
  const sessionOrigin = canonicalOrigin(session.value.origin);
  if (recordingOrigin !== sessionOrigin) errors.push('session origin must match recording origin');
  if (recording.value.recording_id !== session.value.recording_id) errors.push('session recording_id must match recording');

  const actionableOps = selectedRecordingActions(recording.value)
    .map((action) => action.op as Exclude<BrowserExtensionOperation, 'sensitive_input_omitted'>);
  for (const operation of actionableOps) {
    if (!session.value.requested_operations.includes(operation)) {
      errors.push(`requested_operations must include recorded operation ${operation}`);
    }
  }

  const highRiskActions = selectedRecordingActions(recording.value).filter((action) => HIGH_RISK_OPERATIONS.has(action.op));
  const approvalRequired = highRiskActions.length > 0;
  const approvedStepHashes = highRiskActions.map(hashBrowserExtensionAction);

  if (session.value.mode === 'execute') {
    if (recording.value.review?.status !== 'approved') {
      errors.push('execute mode requires an approved recording review');
    }
    if (!session.value.lease) {
      errors.push('execute mode requires an execution lease');
    } else {
      const expiresAt = Date.parse(session.value.lease.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= (input.now || new Date()).getTime()) {
        errors.push('execution lease is expired');
      }
      for (const hash of approvedStepHashes) {
        if (!session.value.lease.approved_step_hashes.includes(hash)) {
          errors.push(`execution lease is missing approval for high-risk action ${hash}`);
        }
      }
    }
    errors.push('extension execution is unavailable until the Native Messaging bridge is installed');
  }

  if (errors.length > 0) return { status: 'blocked', errors, approvalRequired, approvedStepHashes };
  return {
    status: approvalRequired ? 'approval_required' : 'ready_for_review',
    errors: [],
    approvalRequired,
    approvedStepHashes,
  };
}

export function buildBrowserExtensionPipelineCandidate(recording: BrowserExtensionRecording) {
  const validation = validateBrowserExtensionRecording(recording);
  if (!validation.value) throw new Error(`Invalid browser extension recording: ${validation.errors.join('; ')}`);
  const selectedActions = selectedRecordingActions(validation.value);
  const highRiskActions = selectedActions.filter((action) => HIGH_RISK_OPERATIONS.has(action.op));
  return {
    kind: 'browser-extension-pipeline-candidate.v1' as const,
    recording_id: validation.value.recording_id,
    origin: canonicalOrigin(validation.value.tab.origin),
    review_status: validation.value.review?.status || 'pending',
    operations: selectedActions.map((action) => action.op),
    excluded_action_ids: validation.value.review?.status === 'approved'
      ? validation.value.actions
        .filter((action) => action.op !== 'sensitive_input_omitted' && !selectedActions.includes(action))
        .map((action) => action.action_id)
      : [],
    requires_manual_review: true,
    approval_required: highRiskActions.length > 0,
    approved_step_hashes: highRiskActions.map(hashBrowserExtensionAction),
  };
}
