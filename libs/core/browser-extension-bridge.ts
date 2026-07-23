import AjvModule, { type ValidateFunction } from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import { enforceApprovalGate, type ApprovalGateResult } from './approval-gate.js';
import { pathResolver } from './path-resolver.js';
import { safeAppendFile, safeMkdir, safeReadFile, safeStat, safeWriteFile } from './secure-io.js';
import { validateOpInput } from './op-input-contracts.js';
import { resolveBrowserRecordingPipelineOp, normalizeBrowserPipelineOp } from './op-vocabulary.js';

/** Approval-gate operation id for governed Chrome extension execution. */
export const BROWSER_EXTENSION_EXECUTE_OP = 'browser:extension_execute';

/** Default execution lease lifetime: short-lived to bound replay risk. */
const DEFAULT_LEASE_TTL_MS = 5 * 60_000;

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
addFormats(ajv);

const RECORDING_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/browser-recording.schema.json'
);
const SESSION_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/browser-extension-session.schema.json'
);
const RECEIPT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/browser-extension-receipt.schema.json'
);

const HIGH_RISK_OPERATIONS = new Set<BrowserExtensionOperation>([
  'submit_form',
  'upload_file',
  'download_file',
  'delete',
  'purchase',
  'credential_submit',
  'settings_change',
]);

/**
 * Recompute a recording's risk_summary from its actions — the single source of
 * truth for the high-risk set, so callers that rebuild a recording (e.g.
 * self-repair delta merge) don't duplicate the HIGH_RISK_OPERATIONS list.
 */
export function computeRecordingRiskSummary(actions: BrowserExtensionAction[]): {
  requires_manual_review: boolean;
  sensitive_input_omitted: number;
  approval_required_count: number;
} {
  return {
    requires_manual_review: true,
    sensitive_input_omitted: actions.filter((a) => a.op === 'sensitive_input_omitted').length,
    approval_required_count: actions.filter((a) => HIGH_RISK_OPERATIONS.has(a.op)).length,
  };
}

export type BrowserExtensionOperation =
  | 'snapshot'
  | 'screenshot'
  | 'extract_text_ref'
  | 'list_tabs'
  | 'open_tab'
  | 'select_tab'
  | 'navigate'
  | 'click_ref'
  | 'click_if_present'
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
    /**
     * Structural anchor (stable-ancestor CSS path). Replay falls back to it for
     * low-risk ops when name-based resolution fails — e.g. a news headline slot
     * whose text rotates between recording and replay.
     */
    dom_path?: string;
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
  /** Set only for op=navigate: an origin transition (handoff) captured mid-recording. */
  navigation?: {
    from_origin: string;
    to_origin: string;
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
    origin?: string;
    segment_index?: number;
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
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
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

// Defense-in-depth: the extension redacts PII before sending, but Kyberion must
// not persist a recording whose human-readable text still carries raw PII. These
// patterns mirror the client redactor (content.js safeText).
// The trust boundary must be at least as strict as the client. These mirror
// the full content.js safeText pattern set (email/card/postal/phone/long-runs)
// — previously the server only checked email + long runs (review finding S-M2).
const PII_PATTERNS: RegExp[] = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, // email
  /\b(?:\d[ -]?){13,16}\b/, // card numbers
  /〒?\s?\d{3}-\d{4}\b/, // JP postal code
  /(?:\+?\d{1,3}[-\s]?)?\(?\d{2,4}\)?[-\s]?\d{2,4}[-\s]?\d{3,4}\b/, // phone
  /\b\d{12,}\b/, // long digit runs (card/account numbers)
];

/**
 * Conservative secret/token-shape detector (review finding S-M3): an accessible
 * name or label that echoes a typed value (e.g. a "review your input" step) can
 * smuggle a secret into the recording even after PII redaction. We cannot redact
 * such names without breaking the ref-matching contract, so we REJECT the
 * recording instead. The bar is deliberately high (≥16 chars, mixed case + digit,
 * no whitespace) so ordinary UI labels and human text never trip it.
 */
function looksLikeSecretToken(text: string): boolean {
  for (const token of text.split(/\s+/)) {
    if (token.length < 16) continue;
    if (/[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token)) return true;
  }
  return false;
}

function validateRecordingSemantics(recording: BrowserExtensionRecording): string[] {
  const errors: string[] = [];
  const highRiskActions = recording.actions.filter((action) => HIGH_RISK_OPERATIONS.has(action.op));
  const omittedSensitiveActions = recording.actions.filter(
    (action) => action.op === 'sensitive_input_omitted'
  );

  if (!canonicalOrigin(recording.tab.origin))
    errors.push('recording tab.origin must be an http(s) origin');
  if (!recording.risk_summary.requires_manual_review)
    errors.push('recordings must require manual review');
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
    if (action.op === 'click_if_present' && !action.target) {
      errors.push(`action ${action.action_id} (click_if_present) requires a target`);
    }
    if (action.selection && action.op !== 'select_ref') {
      errors.push(`action ${action.action_id} cannot attach a selection state to ${action.op}`);
    }
    // navigate is an origin-transition (handoff) marker: observe-only, carries a
    // valid origin pair, and never targets a DOM element.
    if (action.op === 'navigate') {
      if (action.risk !== 'observe')
        errors.push(`action ${action.action_id} (navigate) must be classified observe`);
      if (
        !action.navigation ||
        !canonicalOrigin(action.navigation.from_origin) ||
        !canonicalOrigin(action.navigation.to_origin)
      ) {
        errors.push(
          `action ${action.action_id} (navigate) requires from_origin/to_origin http(s) origins`
        );
      }
      if (action.target)
        errors.push(`action ${action.action_id} (navigate) must not target an element`);
    } else if (action.navigation) {
      errors.push(`action ${action.action_id} cannot attach navigation to ${action.op}`);
    }
    const texts = [action.summary, action.target?.name, action.selection?.label].filter(
      (text): text is string => typeof text === 'string'
    );
    if (texts.some((text) => PII_PATTERNS.some((pattern) => pattern.test(text)))) {
      errors.push(`action ${action.action_id} contains unredacted PII-like text`);
    }
    if (texts.some((text) => looksLikeSecretToken(text))) {
      errors.push(`action ${action.action_id} label looks like it echoes a secret/token value`);
    }
    if (action.target?.dom_path && !isSafeStructuralDomPath(action.target.dom_path)) {
      errors.push(`action ${action.action_id} contains an unsafe structural DOM path`);
    }
    if (
      action.target?.dom_path &&
      PII_PATTERNS.some((pattern) => pattern.test(action.target.dom_path))
    ) {
      errors.push(`action ${action.action_id} structural DOM path contains PII-like text`);
    }
    // A real accessible name is short; a long one means the element's whole text
    // subtree (page body, other people's data) leaked into the label.
    if ((action.target?.name?.length ?? 0) > 300) {
      errors.push(
        `action ${action.action_id} target name looks like captured body text, not a label`
      );
    }
  }
  if (recording.review) {
    const actionIds = new Set(recording.actions.map((action) => action.action_id));
    const reviewedIds = new Set<string>();
    for (const decision of recording.review.decisions) {
      if (!actionIds.has(decision.action_id))
        errors.push(`review decision references unknown action ${decision.action_id}`);
      if (reviewedIds.has(decision.action_id))
        errors.push(`review contains duplicate decision for ${decision.action_id}`);
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
  const decisions = new Map(
    recording.review.decisions.map((decision) => [decision.action_id, decision.status])
  );
  return actionable.filter((action) => decisions.get(action.action_id) === 'approved');
}

export function validateBrowserExtensionRecording(
  input: unknown
): BrowserExtensionValidationResult<BrowserExtensionRecording> {
  recordingValidator = schemaValidator(RECORDING_SCHEMA_PATH, recordingValidator);
  if (!recordingValidator(input)) return { valid: false, errors: formatErrors(recordingValidator) };
  const value = input as BrowserExtensionRecording;
  const errors = validateRecordingSemantics(value);
  return errors.length > 0 ? { valid: false, errors } : { valid: true, errors: [], value };
}

export function validateBrowserExtensionSessionRequest(
  input: unknown
): BrowserExtensionValidationResult<BrowserExtensionSessionRequest> {
  sessionValidator = schemaValidator(SESSION_SCHEMA_PATH, sessionValidator);
  if (!sessionValidator(input)) return { valid: false, errors: formatErrors(sessionValidator) };
  const value = input as BrowserExtensionSessionRequest;
  if (!canonicalOrigin(value.origin))
    return { valid: false, errors: ['session origin must be an http(s) origin'] };
  return { valid: true, errors: [], value };
}

export function validateBrowserExtensionReceipt(
  input: unknown
): BrowserExtensionValidationResult<BrowserExtensionReceipt> {
  receiptValidator = schemaValidator(RECEIPT_SCHEMA_PATH, receiptValidator);
  if (!receiptValidator(input)) return { valid: false, errors: formatErrors(receiptValidator) };
  const value = input as BrowserExtensionReceipt;
  if (!canonicalOrigin(value.origin))
    return { valid: false, errors: ['receipt origin must be an http(s) origin'] };
  return { valid: true, errors: [], value };
}

export function hashBrowserExtensionAction(action: BrowserExtensionAction): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        action_id: action.action_id,
        op: action.op,
        target: action.target,
        variable: action.variable,
        selection: action.selection,
      })
    )
    .digest('hex');
}

export function preflightBrowserExtensionSession(input: {
  recording: unknown;
  session: unknown;
  now?: Date;
  /**
   * Asserted true only by the Native Messaging host once the local bridge is
   * installed and authenticated. Defaults to false so a plain preflight (no
   * bridge) keeps execute mode blocked.
   */
  bridgeAvailable?: boolean;
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
  if (recording.value.recording_id !== session.value.recording_id)
    errors.push('session recording_id must match recording');

  const actionableOps = selectedRecordingActions(recording.value).map(
    (action) => action.op as Exclude<BrowserExtensionOperation, 'sensitive_input_omitted'>
  );
  for (const operation of actionableOps) {
    if (!session.value.requested_operations.includes(operation)) {
      errors.push(`requested_operations must include recorded operation ${operation}`);
    }
  }

  const highRiskActions = selectedRecordingActions(recording.value).filter((action) =>
    HIGH_RISK_OPERATIONS.has(action.op)
  );
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
    if (!input.bridgeAvailable) {
      errors.push(
        'extension execution is unavailable until the Native Messaging bridge is installed'
      );
    }
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
  if (!validation.value)
    throw new Error(`Invalid browser extension recording: ${validation.errors.join('; ')}`);
  const selectedActions = selectedRecordingActions(validation.value);
  const highRiskActions = selectedActions.filter((action) => HIGH_RISK_OPERATIONS.has(action.op));
  return {
    kind: 'browser-extension-pipeline-candidate.v1' as const,
    recording_id: validation.value.recording_id,
    origin: canonicalOrigin(validation.value.tab.origin),
    review_status: validation.value.review?.status || 'pending',
    operations: selectedActions.map((action) => action.op),
    excluded_action_ids:
      validation.value.review?.status === 'approved'
        ? validation.value.actions
            .filter(
              (action) =>
                action.op !== 'sensitive_input_omitted' && !selectedActions.includes(action)
            )
            .map((action) => action.action_id)
        : [],
    requires_manual_review: true,
    approval_required: highRiskActions.length > 0,
    approved_step_hashes: highRiskActions.map(hashBrowserExtensionAction),
  };
}

export interface BrowserExtensionLease {
  lease_id: string;
  issued_at: string;
  expires_at: string;
  approved_step_hashes: string[];
  /** Set for segmented (multi-origin) execution: the origin this lease is bound to. */
  origin?: string;
  /** Set for segmented execution: which segment (0-based) this lease covers. */
  segment_index?: number;
}

/** One origin segment of a recording, split at `navigate` handoff boundaries. */
export interface RecordingSegment {
  index: number;
  origin: string;
  /** Actionable steps in this segment (the entry `navigate` marker is excluded). */
  actions: BrowserExtensionAction[];
  /** Origin navigated from to enter this segment (undefined for the first segment). */
  entryFrom?: string;
}

/**
 * Split a recording into per-origin segments at `navigate` handoff markers.
 * Segment 0's origin is the recording's tab.origin; each subsequent segment's
 * origin is the preceding navigate's `to_origin`. The navigate markers themselves
 * are boundaries and are not included in any segment's actions.
 *
 * Empty segments (e.g. a recording that ends on a navigate) ARE included so
 * origin guards can vet every origin the recording touches; execution-side
 * consumers (lease issuance) skip them — there is nothing to execute.
 */
export function segmentRecording(recording: BrowserExtensionRecording): RecordingSegment[] {
  const segments: RecordingSegment[] = [];
  let current: RecordingSegment = { index: 0, origin: recording.tab.origin, actions: [] };
  for (const action of recording.actions) {
    if (action.op === 'navigate' && action.navigation) {
      segments.push(current);
      current = {
        index: segments.length,
        origin: action.navigation.to_origin,
        actions: [],
        entryFrom: action.navigation.from_origin,
      };
      continue;
    }
    current.actions.push(action);
  }
  segments.push(current);
  return segments;
}

/**
 * Build a single-origin sub-recording for one segment, so the existing
 * single-origin machinery (preflight / lease / approval) can be reused per
 * segment. origin_hash is recomputed for the segment origin.
 */
export function subRecordingForSegment(
  recording: BrowserExtensionRecording,
  segment: RecordingSegment
): BrowserExtensionRecording {
  return {
    ...recording,
    tab: {
      ...recording.tab,
      origin: segment.origin,
      origin_hash: createHash('sha256').update(segment.origin).digest('hex'),
    },
    actions: segment.actions,
    risk_summary: computeRecordingRiskSummary(segment.actions),
    review: recording.review
      ? {
          ...recording.review,
          decisions: recording.review.decisions.filter((d) =>
            segment.actions.some((a) => a.action_id === d.action_id)
          ),
        }
      : recording.review,
  };
}

/** One segment's issued lease, bound to that segment's origin. */
export interface SegmentedLease {
  segment_index: number;
  origin: string;
  lease: BrowserExtensionLease;
}

/**
 * Issue one origin-bound lease per segment of a (possibly multi-origin)
 * recording. A single approval covers all high-risk steps across segments; each
 * lease only carries its own segment's approved high-risk hashes and is pinned to
 * that segment's origin. Returns all-or-nothing.
 *
 * Segments with no actionable steps (e.g. a trailing navigate) get no lease —
 * an empty sub-recording would fail validation and there is nothing to execute.
 * The returned leases' segment_index can therefore be non-contiguous.
 */
export function issueSegmentedLeases(input: {
  recording: BrowserExtensionRecording;
  session: BrowserExtensionSessionRequest;
  approval: ApprovalGateResult;
  ttlMs?: number;
  now?: Date;
}): { leases?: SegmentedLease[]; errors: string[] } {
  const segments = segmentRecording(input.recording);
  const leases: SegmentedLease[] = [];
  for (const segment of segments) {
    if (segment.actions.length === 0) continue;
    const sub = subRecordingForSegment(input.recording, segment);
    const subSession: BrowserExtensionSessionRequest = { ...input.session, origin: segment.origin };
    const issued = issueBrowserExtensionLease({
      recording: sub,
      session: subSession,
      approval: input.approval,
      ttlMs: input.ttlMs,
      now: input.now,
    });
    if (issued.errors.length > 0 || !issued.lease) {
      return {
        errors: [
          `segment ${segment.index} (${segment.origin}): ${issued.errors.join('; ') || 'lease issuance failed'}`,
        ],
      };
    }
    leases.push({
      segment_index: segment.index,
      origin: segment.origin,
      lease: { ...issued.lease, origin: segment.origin, segment_index: segment.index },
    });
  }
  if (leases.length === 0) {
    return { errors: ['segmented recording contains no actionable segment'] };
  }
  return { leases, errors: [] };
}

/**
 * Enforce the approval gate for the high-risk actions in an approved recording.
 *
 * Only the actions that survived review (selectedRecordingActions) are
 * considered. When none are high-risk, no approval is required and the gate
 * returns immediately; otherwise the decision is delegated to the shared
 * approval gate keyed on {@link BROWSER_EXTENSION_EXECUTE_OP}.
 */
export function enforceBrowserExtensionApproval(input: {
  recording: BrowserExtensionRecording;
  session: BrowserExtensionSessionRequest;
  agentId: string;
  channel?: string;
  correlationId?: string;
}): ApprovalGateResult {
  const highRiskActions = selectedRecordingActions(input.recording).filter((action) =>
    HIGH_RISK_OPERATIONS.has(action.op)
  );
  if (highRiskActions.length === 0) {
    return {
      allowed: true,
      status: 'not_required',
      message: 'No high-risk actions require approval',
    };
  }
  return enforceApprovalGate({
    intentId: BROWSER_EXTENSION_EXECUTE_OP,
    operationId: BROWSER_EXTENSION_EXECUTE_OP,
    agentId: input.agentId,
    correlationId:
      input.correlationId || `${input.session.mission_id}:${input.session.recording_id}`,
    channel: input.channel || 'browser-extension',
    payload: {
      origin: input.session.origin,
      mission_id: input.session.mission_id,
      operations: highRiskActions.map((action) => action.op),
    },
    draft: {
      title: `Chrome 実行: ${input.session.origin}`,
      summary: `${highRiskActions.length} 件の高リスク操作（${highRiskActions.map((action) => action.op).join(', ')}）`,
      severity: 'high',
    },
  });
}

function sanitizeReceiptFileName(receiptId: string): string {
  const normalized = String(receiptId || '')
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : `receipt-${randomUUID()}`;
}

/**
 * Issue a short-lived execution lease for an approved recording. The lease binds
 * the approved high-risk step hashes so the extension can only replay what was
 * actually reviewed and (when required) approved.
 */
export function issueBrowserExtensionLease(input: {
  recording: BrowserExtensionRecording;
  session: BrowserExtensionSessionRequest;
  approval: ApprovalGateResult;
  leaseId?: string;
  ttlMs?: number;
  now?: Date;
}): { lease?: BrowserExtensionLease; errors: string[] } {
  const errors: string[] = [];
  if (input.recording.review?.status !== 'approved') {
    errors.push('lease requires an approved recording review');
  }
  if (input.recording.recording_id !== input.session.recording_id) {
    errors.push('lease session recording_id must match the recording');
  }
  const highRiskActions = selectedRecordingActions(input.recording).filter((action) =>
    HIGH_RISK_OPERATIONS.has(action.op)
  );
  if (highRiskActions.length > 0 && !input.approval.allowed) {
    errors.push('lease requires granted approval for high-risk actions');
  }
  if (errors.length > 0) return { errors };

  const now = input.now || new Date();
  const ttl = input.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  return {
    errors: [],
    lease: {
      lease_id: input.leaseId || `LEASE-${randomUUID()}`,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + ttl).toISOString(),
      approved_step_hashes: highRiskActions.map(hashBrowserExtensionAction),
    },
  };
}

/** Extended TTL granted after an MFA challenge is detected. */
const MFA_EXTENSION_TTL_MS = 10 * 60_000;
/** Prefix marking a lease that is itself an MFA extension (used to cap chaining). */
const MFA_LEASE_PREFIX = 'LEASE-MFA-';

/**
 * Extend an execution lease when the extension signals an MFA challenge mid-replay.
 *
 * The original lease's approved_step_hashes are carried over unchanged — no new
 * approval is required. Hardened per security review (S-H2):
 *   - The lease must still be VALID (`now <= expires_at`). A past-expiry grace
 *     window is no longer honored — an expired lease requires fresh issuance,
 *     not silent resurrection.
 *   - An already-MFA-extended lease cannot be extended again (single extension
 *     cap) so the time bound cannot be chained open indefinitely.
 *
 * Dispatcher (Agent-C) calls this; do NOT use outside the procedure execution path.
 * Design: docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md §7 Layer③
 */
export function extendLeaseForMfa(input: {
  existingLease: BrowserExtensionLease;
  recording: BrowserExtensionRecording;
  session: BrowserExtensionSessionRequest;
  extensionTtlMs?: number;
  now?: Date;
}): { lease?: BrowserExtensionLease; errors: string[] } {
  const errors: string[] = [];
  const now = input.now ?? new Date();
  const extensionTtl = input.extensionTtlMs ?? MFA_EXTENSION_TTL_MS;

  const expiresAt = Date.parse(input.existingLease.expires_at);
  if (!Number.isFinite(expiresAt) || now.getTime() > expiresAt) {
    errors.push(
      `lease ${input.existingLease.lease_id} is expired; MFA extension requires a still-valid lease` +
        ` (expired ${Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : 'invalid'})`
    );
  }
  if (input.existingLease.lease_id.startsWith(MFA_LEASE_PREFIX)) {
    errors.push(
      'lease has already been MFA-extended once; re-issue a lease instead of chaining extensions'
    );
  }
  if (input.recording.review?.status !== 'approved') {
    errors.push('MFA lease extension requires an approved recording review');
  }
  if (input.recording.recording_id !== input.session.recording_id) {
    errors.push('MFA lease extension: session recording_id must match recording');
  }
  if (errors.length > 0) return { errors };

  return {
    errors: [],
    lease: {
      lease_id: `${MFA_LEASE_PREFIX}${randomUUID()}`,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + extensionTtl).toISOString(),
      // Carry over the same hashes — the approved actions have not changed
      approved_step_hashes: [...input.existingLease.approved_step_hashes],
    },
  };
}

export interface BrowserRecordingPipelineDraft {
  pipeline_id: string;
  version: string;
  description: string;
  action: 'pipeline';
  _source: {
    kind: 'browser-recording.v1';
    recording_id: string;
    origin: string | null;
    review_status: string;
  };
  _draft: true;
  _review_required: string[];
  options: { record_trace: boolean };
  steps: Array<{
    id: string;
    type: 'apply' | 'capture' | 'transform' | 'control';
    op: string;
    params: Record<string, unknown>;
  }>;
}

// Recording ops that the Playwright browser-actuator can already execute
// directly against a `{ref, role, name, dom_path}` target (no CSS selector),
// via `resolveRefOrRecordedTarget` (libs/actuators/browser-actuator/src/recorded-ref-resolver.ts).
// Keyed by the recording's own op name; note `wait_for_ref` (recording) maps
// to the actuator's `wait_ref` case — the names never aligned.
const PLAYWRIGHT_DIRECT_REF_OPS: Record<string, string> = {
  click_ref: 'click_ref',
  fill_ref: 'fill_ref',
  press_ref: 'press_ref',
  extract_text_ref: 'extract_text_ref',
  wait_for_ref: 'wait_ref',
};

/**
 * Deterministically crystallize an (ideally approved) recording into a
 * browser-pipeline.schema-conformant **draft** ADF.
 *
 * For `executionSubstrate: 'extension'` (default, unchanged): the draft is
 * never directly runnable — recordings carry refs, not selectors — so
 * `_review_required` always lists the gaps a human must close before the
 * pipeline is promoted to the reusable registry.
 *
 * For `executionSubstrate: 'playwright'`: ops with a direct ref-aware
 * actuator handler (`PLAYWRIGHT_DIRECT_REF_OPS`) are kept as-is (plus
 * `dom_path`) instead of being normalized to the selector-only canonical
 * ops, since `resolveRefOrRecordedTarget` resolves them against the live
 * page at run time — no manual selector resolution needed for those steps.
 * Ops without a direct ref-aware handler still fall back to the existing
 * normalize+`needs_selector` path. The high-risk-approval review line is
 * always kept regardless of substrate: a clean ref resolution says nothing
 * about whether the action itself is safe to auto-run.
 */
export function compileBrowserRecordingToPipeline(
  recording: BrowserExtensionRecording,
  opts: { pipelineId?: string; executionSubstrate?: 'extension' | 'playwright' } = {}
): BrowserRecordingPipelineDraft {
  const validation = validateBrowserExtensionRecording(recording);
  if (!validation.value)
    throw new Error(`Invalid browser extension recording: ${validation.errors.join('; ')}`);
  const value = validation.value;
  const selected = selectedRecordingActions(value);
  const isPlaywright = opts.executionSubstrate === 'playwright';
  let hasUnresolvedRefStep = false;

  const steps = selected.map((action, index) => {
    const params: Record<string, unknown> = {};
    params.original_op = action.op;
    const directRefOp = isPlaywright ? PLAYWRIGHT_DIRECT_REF_OPS[action.op] : undefined;
    if (action.target) {
      params.ref = action.target.ref;
      params.role = action.target.role;
      params.name = action.target.name;
      if (directRefOp) {
        if (action.target.dom_path) params.dom_path = action.target.dom_path;
      } else {
        params.needs_selector = true; // recording has no selector; resolve before run
        hasUnresolvedRefStep = true;
      }
    }
    if (action.op === 'fill_ref' && action.variable) {
      params.text = `{{${action.variable.name}}}`;
      params.classification = action.variable.classification;
    }
    if (action.op === 'select_ref' && action.selection) {
      params.selection = action.selection;
    }
    if (HIGH_RISK_OPERATIONS.has(action.op)) {
      params.high_risk = true;
      params.original_op = action.op;
    }
    const op =
      directRefOp ?? normalizeBrowserPipelineOp(resolveBrowserRecordingPipelineOp(action.op));
    const validation = validateOpInput('browser', op, { ...action, ...params });
    if (!validation.valid) {
      const { errors } = validation as { valid: false; errors: string[] };
      throw new Error(
        `Invalid browser recording action ${action.action_id} (${action.op}): ${errors.join('; ')}`
      );
    }
    return {
      id: `step-${index + 1}`,
      type: 'apply' as const,
      op,
      params,
    };
  });

  const reviewRequired: string[] = [];
  if (hasUnresolvedRefStep) {
    reviewRequired.push('Resolve ref → Playwright selector for every step before promotion');
  }
  if (selected.some((action) => HIGH_RISK_OPERATIONS.has(action.op))) {
    reviewRequired.push('High-risk steps require an approval gate at run time');
  }
  if (selected.some((action) => action.op === 'select_ref')) {
    reviewRequired.push(
      'select_ref was normalized to click; verify the selection mapping before promotion'
    );
  }
  if (value.review?.status !== 'approved') {
    reviewRequired.push('Recording review is not finalized; approve before promotion');
  }

  return {
    pipeline_id: opts.pipelineId || `browser-${value.recording_id}`,
    version: '0.1.0-draft',
    description: `Draft pipeline crystallized from recording ${value.recording_id} on ${canonicalOrigin(value.tab.origin)}`,
    action: 'pipeline',
    _source: {
      kind: 'browser-recording.v1',
      recording_id: value.recording_id,
      origin: canonicalOrigin(value.tab.origin),
      review_status: value.review?.status || 'pending',
    },
    _draft: true,
    _review_required: reviewRequired,
    options: { record_trace: true },
    steps,
  };
}

/** Construct a schema-valid execution receipt for persistence/evidence. */
export function buildBrowserExtensionReceipt(input: {
  session: BrowserExtensionSessionRequest;
  status: BrowserExtensionReceipt['status'];
  receiptId?: string;
  leaseId?: string;
  approvalRuleId?: string;
  evidenceRefs?: string[];
  summary?: string;
  now?: Date;
}): BrowserExtensionReceipt {
  const receipt: BrowserExtensionReceipt = {
    kind: 'browser-extension-receipt.v1',
    receipt_id: input.receiptId || `RCP-${randomUUID()}`,
    mission_id: input.session.mission_id,
    pipeline_id: input.session.pipeline_id,
    recording_id: input.session.recording_id,
    tab_id: input.session.tab_id,
    origin: input.session.origin,
    status: input.status,
    created_at: (input.now || new Date()).toISOString(),
  };
  if (input.leaseId) receipt.lease_id = input.leaseId;
  if (input.approvalRuleId) receipt.approval_rule_id = input.approvalRuleId;
  if (input.evidenceRefs?.length) receipt.evidence_refs = input.evidenceRefs;
  if (input.summary) receipt.summary = input.summary;
  return receipt;
}

/** Directory under active/shared where execution receipts are persisted as evidence. */
const RECEIPT_STORE = pathResolver.shared('runtime/browser-receipts');

/**
 * Persist a validated execution receipt as durable evidence and return the path.
 *
 * Until the full mission lifecycle takes ownership of evidence, receipts must
 * still land on disk so an operator can later audit what was authorized and
 * executed — acknowledging-and-dropping leaves no trail (review finding OP-H3).
 * The receipt is re-validated here so a malformed receipt is never written.
 */
export function persistBrowserExtensionReceipt(receipt: unknown): {
  path?: string;
  errors: string[];
} {
  const validation = validateBrowserExtensionReceipt(receipt);
  if (!validation.valid || !validation.value) {
    return { errors: validation.errors };
  }
  try {
    safeMkdir(RECEIPT_STORE, { recursive: true });
    const filePath = `${RECEIPT_STORE}/${sanitizeReceiptFileName(validation.value.receipt_id)}.json`;
    safeWriteFile(filePath, JSON.stringify(validation.value, null, 2));
    return { path: filePath, errors: [] };
  } catch (err) {
    return {
      errors: [`failed to persist receipt: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

// ---------------------------------------------------------------------------
// Observations — read-only data extracted from reviewed page regions
// ---------------------------------------------------------------------------

const OBSERVATION_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/browser-observation.schema.json'
);
const OBSERVATION_STORE = pathResolver.knowledge('personal/browser-observations');
let observationValidator: ValidateFunction | null = null;

export interface BrowserExtensionObservationField {
  name: string;
  text: string;
  dom_path?: string;
}

export interface BrowserExtensionObservation {
  schema_version: 'browser-observation.v1';
  observation_id: string;
  procedure_id: string;
  recording_id: string;
  lease_id: string;
  origin: string;
  captured_at: string;
  source: 'chrome-extension';
  fields: BrowserExtensionObservationField[];
}

const MAX_OBSERVATION_STORE_BYTES = 5 * 1024 * 1024;
const MAX_OBSERVATION_LIMIT = 50;

/** Only accept selectors emitted by content.js structuralPath(). */
export function isSafeStructuralDomPath(value: string): boolean {
  if (value.length === 0 || value.length > 600) return false;
  const segment = '(?:[a-z][a-z0-9]*(?::nth-of-type\\(\\d+\\))?|#[A-Za-z][A-Za-z0-9_-]*)';
  return new RegExp(`^${segment}(?: > ${segment})*$`, 'i').test(value);
}

/**
 * Server-side redaction for extracted page text — mirrors content.js safeText.
 * Observations legitimately carry page content, so unlike recordings we REDACT
 * rather than reject: the data still flows, minus PII shapes.
 */
export function redactObservationText(value: string): string {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b(?:\d[ -]?){13,16}\b/g, '[redacted-card]')
    .replace(/(?:\+?\d{1,3}[-\s]?)?\(?\d{2,4}\)?[-\s]?\d{2,4}[-\s]?\d{3,4}\b/g, '[redacted-phone]')
    .replace(/〒?\s?\d{3}-\d{4}\b/g, '[redacted-postal]')
    .replace(/\b\d{12,}\b/g, '[redacted-number]');
}

export function validateBrowserExtensionObservation(
  input: unknown
): BrowserExtensionValidationResult<BrowserExtensionObservation> {
  observationValidator = schemaValidator(OBSERVATION_SCHEMA_PATH, observationValidator);
  if (!observationValidator(input))
    return { valid: false, errors: formatErrors(observationValidator) };
  const value = input as BrowserExtensionObservation;
  const origin = canonicalOrigin(value.origin);
  if (!origin || origin !== value.origin)
    return { valid: false, errors: ['observation origin must be an http(s) origin'] };
  if (
    value.fields.some(
      (field) =>
        (field.dom_path && !isSafeStructuralDomPath(field.dom_path)) ||
        (field.dom_path && PII_PATTERNS.some((pattern) => pattern.test(field.dom_path)))
    )
  )
    return { valid: false, errors: ['observation contains an unsafe structural DOM path'] };
  return { valid: true, errors: [], value };
}

function sanitizeObservationFileName(procedureId: string): string {
  return procedureId.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Append a validated observation to the per-procedure JSONL store (append-only,
 * so point-in-time reports and time-series analysis share one source). Field
 * text is re-redacted at this trust boundary regardless of client behavior.
 */
export function persistBrowserExtensionObservation(observation: unknown): {
  path?: string;
  errors: string[];
} {
  const validation = validateBrowserExtensionObservation(observation);
  if (!validation.valid || !validation.value) return { errors: validation.errors };
  const redacted: BrowserExtensionObservation = {
    ...validation.value,
    fields: validation.value.fields.map((field) => ({
      ...field,
      name: redactObservationText(field.name),
      text: redactObservationText(field.text),
    })),
  };
  try {
    safeMkdir(OBSERVATION_STORE, { recursive: true });
    const filePath = `${OBSERVATION_STORE}/${sanitizeObservationFileName(redacted.procedure_id)}.jsonl`;
    try {
      if (
        safeStat(filePath).size + Buffer.byteLength(`${JSON.stringify(redacted)}\n`, 'utf8') >
        MAX_OBSERVATION_STORE_BYTES
      ) {
        return {
          errors: ['observation store limit reached; rotate or archive older observations'],
        };
      }
    } catch {
      // The per-procedure file does not exist yet.
    }
    safeAppendFile(filePath, `${JSON.stringify(redacted)}\n`);
    return { path: filePath, errors: [] };
  } catch (err) {
    return {
      errors: [
        `failed to persist observation: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}

/**
 * Load the most recent observations for a procedure (oldest → newest within the
 * returned window). Tolerates and skips corrupt JSONL lines.
 */
export function loadBrowserExtensionObservations(
  procedureId: string,
  options: { limit?: number } = {}
): BrowserExtensionObservation[] {
  const limit = Math.min(
    MAX_OBSERVATION_LIMIT,
    options.limit && options.limit > 0 ? Math.floor(options.limit) : MAX_OBSERVATION_LIMIT
  );
  const filePath = `${OBSERVATION_STORE}/${sanitizeObservationFileName(procedureId)}.jsonl`;
  let raw: string;
  try {
    if (safeStat(filePath).size > MAX_OBSERVATION_STORE_BYTES) return [];
    raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  } catch {
    return [];
  }
  const observations: BrowserExtensionObservation[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = validateBrowserExtensionObservation(JSON.parse(line));
      if (parsed.value) observations.push(parsed.value);
    } catch {
      // skip corrupt lines
    }
  }
  return observations.slice(-limit);
}
