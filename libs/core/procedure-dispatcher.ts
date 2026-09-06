import { logger } from './core.js';
import { randomUUID } from 'node:crypto';
import { enforceApprovalGate } from './approval-gate.js';
import { recordGovernanceAction } from './kill-switch.js';
import { matchesAllowedOrigin } from './origin-policy.js';
import {
  type BrowserExtensionLease,
  type BrowserExtensionRecording,
  type BrowserExtensionSessionRequest,
  type SegmentedLease,
  compileBrowserRecordingToPipeline,
  enforceBrowserExtensionApproval,
  issueBrowserExtensionLease,
  issueSegmentedLeases,
  preflightBrowserExtensionSession,
  segmentRecording,
  subRecordingForSegment,
} from './browser-extension-bridge.js';
import {
  isExternalEffectStep,
  type ServiceRecording,
  validateServiceRecording,
} from './service-recording.js';
import {
  executeServiceProcedure,
  type ServicePresetRunner,
  type ServiceStepResult,
} from './service-procedure-executor.js';
import { type ProcedureEntry } from './procedure-types.js';
import { RISKY_OPS } from './risky-op-registry.js';
import { osAutomationBridge, type OsAutomationBridge } from './os-automation-bridge.js';
import {
  computeDesktopRecordingHash,
  validateDesktopRecording,
  type DesktopRecording,
} from './desktop-recording.js';
import {
  intentDraftHash,
  validateDesktopIntentDraft,
  type DesktopIntentDraft,
} from './desktop-intent-reconstruction.js';
import {
  loadDesktopPipeline,
  validateDesktopPipeline,
  type DesktopPipeline,
} from './desktop-pipeline.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeMkdir, safeRmSync } from './secure-io.js';
import { redactScreenCaptureFile } from './screen-frame-redaction.js';

/** Approval-gate operation id for external-effect service actions. */
export const SERVICE_EXTERNAL_EFFECT_OP = 'service:external_effect';

// re-export for consumers that need it alongside dispatch
export { extendLeaseForMfa } from './browser-extension-bridge.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Outcome of a dispatch attempt.
 *
 * - `lease_issued`       — browser substrate: lease ready for the extension to use.
 * - `approval_required`  — a human approval request is pending; retry after approval.
 * - `blocked`            — hard error; the procedure cannot execute.
 * - `not_implemented`    — a separate substrate executor is not yet wired up (currently media only).
 */
export type DispatchStatus =
  'lease_issued' | 'executed' | 'approval_required' | 'blocked' | 'not_implemented';

export interface DispatchInput {
  /** The procedure to execute (from the catalog). */
  procedure: ProcedureEntry;
  /** Agent identity for the approval gate audit trail. */
  agentId: string;
  /** Owning mission. */
  missionId: string;
  pipelineId?: string;
  /**
   * Required for `extension_session` executor.
   * Must have `review.status === 'approved'` for lease issuance.
   */
  recording?: BrowserExtensionRecording;
  /**
   * Required for `extension_session` executor.
   * Must have `recording_id` and `origin` matching the recording.
   */
  session?: BrowserExtensionSessionRequest;
  /** Required for the `service:preset` executor (review must be approved). */
  serviceRecording?: ServiceRecording;
  /** User inputs for `{{input.NAME}}` placeholders (service execution). */
  serviceInputs?: Record<string, unknown>;
  /** Injected preset runner for service execution (tests). Defaults to the real engine. */
  executePreset?: ServicePresetRunner;
  /** Human-reviewed desktop recording for the system executor. */
  desktopRecording?: DesktopRecording;
  /** Human-reviewed intent artifact bound to the desktop recording. */
  desktopIntent?: DesktopIntentDraft;
  /** Runtime inputs for variable desktop text steps; raw values are never persisted. */
  desktopInputs?: Record<string, string>;
  /** Injectable bridge for hermetic dispatcher tests. Defaults to the OS bridge. */
  desktopBridge?: Partial<OsAutomationBridge>;
  /** Injectable screenshot redactor for hermetic tests; production always redacts before returning. */
  desktopScreenRedactor?: (inputPath: string, outputPath: string) => Promise<void>;
  /** Injectable validated pipeline for hermetic tests; CLI loads it from pipeline_ref. */
  desktopPipeline?: DesktopPipeline;
  /** Set false for pre-trust callers; project-local desktop pipelines are then rejected. */
  trustResolved?: boolean;
  /**
   * Required for `execution_substrate: 'playwright'` browser procedures. Runs
   * the compiled pipeline steps through the Playwright browser-actuator.
   * Injected (rather than statically imported) because `libs/core` does not
   * depend on `libs/actuators/*` — the caller (e.g. a `scripts/*.ts` entry
   * point) wires in the real `handleAction` from `@agent/browser-actuator`.
   */
  executeBrowserPipeline?: (input: {
    steps: Array<{ id: string; type: string; op: string; params: Record<string, unknown> }>;
    sessionId?: string;
    options?: Record<string, unknown>;
  }) => Promise<{ status: 'succeeded' | 'failed'; results?: unknown[]; errors?: string[] }>;
  /** Surface channel forwarded to the approval gate (e.g. "browser-extension"). */
  channel?: string;
  correlationId?: string;
  /** Trusted caller-side human presence signal for approval-gated effects. */
  hasHuman?: boolean;
  hasUI?: boolean;
  nonInteractive?: boolean;
}

export interface DispatchResult {
  status: DispatchStatus;
  /** `extension_session` single-origin: the lease the extension uses to authorize execution. */
  lease?: BrowserExtensionLease;
  /**
   * `extension_session` multi-origin (segmented): one origin-bound lease per
   * segment. Present instead of `lease` when the procedure spans >1 origin.
   */
  segments?: SegmentedLease[];
  /** `service:preset`: per-step execution results (status === 'executed'). */
  serviceResults?: ServiceStepResult[];
  /** `execution_substrate: 'playwright'`: per-step results from the browser-actuator. */
  browserResults?: unknown[];
  /** Set when `status === 'approval_required'`. */
  approvalRequestId?: string;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Route a procedure execution request to the correct substrate executor.
 *
 * Currently implemented: browser, service:preset, and reviewed desktop system procedures.
 *
 * Agent-C (Dispatcher) in the intent-driven automation design.
 * Design: docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md §7 Layer③
 */
export async function dispatchProcedure(input: DispatchInput): Promise<DispatchResult> {
  // Layer C substrate branch (design doc §7/§9): browser procedures authored
  // for Playwright execution are routed to a dedicated function so the
  // existing `extension_session` path (dispatchExtensionSession) never has to
  // be edited to accommodate the new substrate.
  if (
    input.procedure.substrate === 'browser' &&
    input.procedure.execution_substrate === 'playwright'
  ) {
    return dispatchPlaywrightPipeline(input);
  }

  const executor = input.procedure.adapter.executor;
  switch (executor) {
    case 'extension_session':
      return dispatchExtensionSession(input);
    case 'service:preset':
      return dispatchServiceSession(input);
    case 'system':
      return dispatchDesktopProcedure(input);
    case 'media:pipeline':
      // Media recipe→pipeline mapping is a separate phase.
      logger.info(`[procedure-dispatcher] executor "${executor}" is not yet implemented`);
      return {
        status: 'not_implemented',
        errors: [`Executor "${executor}" is not yet implemented (planned substrate adapter)`],
      };
    default:
      return {
        status: 'blocked',
        errors: [`Unknown executor: "${executor}"`],
      };
  }
}

// ---------------------------------------------------------------------------
// Desktop / system executor
// ---------------------------------------------------------------------------

type DesktopStep = DesktopRecording['steps'][number];
const DESKTOP_READ_ONLY_OPS = new Set([
  'screenshot',
  'get_focused_input',
  'window_list',
  'clipboard_read',
  'chrome_tab_list',
  'wait_for_element',
]);
const DESKTOP_NON_DESTRUCTIVE_OPS = new Set(['activate_application', 'activate_window_by_title']);
const DESKTOP_OP_ALIASES: Record<string, string> = {
  focus_window: 'activate_window_by_title',
  click_element: 'mouse_click',
  type_text: 'keyboard',
  key_combo: 'press_key',
  screenshot: 'screenshot',
  click_at: 'mouse_click',
  right_click_at: 'right_click',
  keystroke_text: 'keyboard',
};

function desktopOperation(step: DesktopStep): string {
  return DESKTOP_OP_ALIASES[step.op] || step.op;
}

function desktopApprovalRequired(step: DesktopStep): boolean {
  const op = desktopOperation(step);
  return !DESKTOP_READ_ONLY_OPS.has(op) && !DESKTOP_NON_DESTRUCTIVE_OPS.has(op);
}

function desktopTargetMatches(
  step: DesktopStep,
  bridge: OsAutomationBridge,
  op: string
): string | null {
  const selector = step.selector || {};
  if (selector.app && selector.window_title) {
    const windows = bridge.getWindowList(selector.app);
    if (
      !windows.some(
        (title) => title === selector.window_title || title.includes(selector.window_title!)
      )
    ) {
      return `desktop target window not found: ${selector.app}/${selector.window_title}`;
    }
  }
  if (
    op !== 'activate_application' &&
    op !== 'activate_window_by_title' &&
    (selector.app || selector.window_title)
  ) {
    const focused = bridge.detectFocusedInput();
    if (selector.app && focused.application !== selector.app)
      return `desktop foreground app mismatch: expected ${selector.app}, got ${focused.application || 'empty'}`;
    if (
      selector.window_title &&
      focused.windowTitle !== selector.window_title &&
      !focused.windowTitle.includes(selector.window_title)
    ) {
      return `desktop foreground window mismatch: expected ${selector.window_title}, got ${focused.windowTitle || 'empty'}`;
    }
  }
  if (selector.role || selector.description || selector.editable !== undefined) {
    const focused = bridge.detectFocusedInput();
    if (selector.role && focused.role !== selector.role)
      return `desktop AX role mismatch: expected ${selector.role}, got ${focused.role || 'empty'}`;
    if (selector.description && !focused.description.includes(selector.description))
      return `desktop AX description mismatch: expected ${selector.description}`;
    if (selector.editable !== undefined && focused.editable !== selector.editable)
      return `desktop AX editable mismatch`;
  }
  return null;
}

function desktopApproval(
  input: DispatchInput,
  step: DesktopStep,
  op: string
): DispatchResult | null {
  if (!desktopApprovalRequired(step)) return null;
  // A caller-level correlation identifies the run, while each destructive
  // desktop step needs its own approval binding. Reusing the run id directly
  // would make approval-gate compare the next step's payload with the first
  // step and return a permanent effect_mismatch.
  const correlationBase =
    input.correlationId ||
    `procedure:${input.procedure.procedure_id}:${input.desktopRecording?.recording_id || 'desktop'}`;
  const approval = enforceApprovalGate({
    operationId: RISKY_OPS.DESKTOP_DESTRUCTIVE_ACTION,
    intentId: RISKY_OPS.DESKTOP_DESTRUCTIVE_ACTION,
    agentId: input.agentId,
    correlationId: `${correlationBase}:step:${step.step_id}`,
    channel: input.channel || 'desktop',
    ...(input.hasHuman !== undefined ? { hasHuman: input.hasHuman } : {}),
    ...(input.hasUI !== undefined ? { hasUI: input.hasUI } : {}),
    ...(input.nonInteractive !== undefined ? { nonInteractive: input.nonInteractive } : {}),
    payload: {
      operation: op,
      procedure_id: input.procedure.procedure_id,
      mission_id: input.missionId,
      target: step.selector || {},
      rationale: 'Desktop operations are coordinate-sensitive and may have external effects.',
    },
  });
  if (approval.allowed) return null;
  return {
    status: 'approval_required',
    approvalRequestId: approval.requestId,
    errors: [approval.message || `approval required for desktop:${op}`],
  };
}

function desktopText(step: DesktopStep, inputs: Record<string, string>): string | null {
  const variable =
    step.variable?.name ||
    (typeof step.selector?.description === 'string' &&
    step.selector.description.startsWith('{{input.')
      ? step.selector.description.slice(8, -2)
      : undefined);
  return variable ? inputs[variable] || null : null;
}

function validateDesktopExecutionContract(
  input: DispatchInput,
  recording: DesktopRecording
): string | null {
  const recordingValidation = validateDesktopRecording(recording);
  if (!recordingValidation.value) return recordingValidation.errors.join('; ');
  const pipelineResult = input.desktopPipeline
    ? validateDesktopPipeline(input.desktopPipeline)
    : loadDesktopPipeline(input.procedure.pipeline_ref, { trustResolved: input.trustResolved });
  if (!pipelineResult.value) return pipelineResult.errors.join('; ');
  const pipeline = pipelineResult.value;
  if (pipeline.procedure_id !== input.procedure.procedure_id)
    return 'desktop pipeline procedure_id mismatch';
  if (pipeline.recording_ref !== input.procedure.adapter.recording_ref)
    return 'desktop pipeline recording_ref mismatch';
  if (pipeline.recording_hash !== recording.recording_hash)
    return 'desktop pipeline recording_hash mismatch';
  if (pipeline.steps.length !== recording.steps.length)
    return 'desktop pipeline step count mismatch';
  for (let index = 0; index < recording.steps.length; index += 1) {
    const pipelineStep = pipeline.steps[index];
    const recordingStep = recording.steps[index];
    if (
      pipelineStep.step_id !== recordingStep.step_id ||
      pipelineStep.op !== `system:${recordingStep.op}`
    ) {
      return `desktop pipeline step mismatch at index ${index}`;
    }
    if (pipelineStep.native_op) {
      return `desktop pipeline selects native operation ${pipelineStep.native_op}; native executor is required and GUI replay is blocked`;
    }
  }
  if (!recording.intent_hash) return 'desktop execution requires an intent review artifact';
  if (!input.desktopIntent) return 'desktop execution requires the reviewed intent artifact';
  let intent: DesktopIntentDraft;
  try {
    intent = validateDesktopIntentDraft(input.desktopIntent);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  if (intent.source_recording_id !== recording.recording_id)
    return 'desktop intent source_recording_id mismatch';
  if (intent.review.status !== 'approved')
    return 'desktop execution requires an approved intent review';
  if (intentDraftHash(intent) !== recording.intent_hash)
    return 'desktop intent hash mismatch; reviewed intent must match the recording';
  return null;
}

async function dispatchDesktopProcedure(input: DispatchInput): Promise<DispatchResult> {
  const recording = input.desktopRecording;
  if (!recording)
    return { status: 'blocked', errors: ['system executor requires a desktopRecording'] };
  const contractError = validateDesktopExecutionContract(input, recording);
  if (contractError) return { status: 'blocked', errors: [contractError] };
  if (recording.review.status !== 'approved')
    return {
      status: 'blocked',
      errors: ['desktop execution requires an approved recording review'],
    };
  if (recording.steps.some((step) => step.needs_semantic_resolution))
    return {
      status: 'blocked',
      errors: ['desktop execution requires semantic targets to be resolved'],
    };
  if (recording.recording_hash !== computeDesktopRecordingHash(recording))
    return {
      status: 'blocked',
      errors: ['desktop recording hash mismatch; reviewed content cannot be executed'],
    };
  const bridge = { ...osAutomationBridge, ...(input.desktopBridge || {}) } as OsAutomationBridge;
  const redactScreenshot = input.desktopScreenRedactor || redactScreenCaptureFile;
  const inputs = input.desktopInputs || {};
  const results: unknown[] = [];
  for (const step of recording.steps) {
    const op = desktopOperation(step);
    const targetError = desktopTargetMatches(step, bridge, op);
    if (targetError)
      return {
        status: 'blocked',
        errors: [targetError, 'desktop execution stopped; operator must re-target the step'],
      };
    const approvalError = desktopApproval(input, step, op);
    if (approvalError) return approvalError;
    const selector = step.selector || {};
    const params = (step as DesktopStep & { params?: Record<string, unknown> }).params || {};
    try {
      let result: unknown;
      switch (op) {
        case 'activate_application':
          result = bridge.activateApplication(selector.app || input.procedure.target.name);
          break;
        case 'activate_window_by_title':
          result = bridge.activateWindowByTitle(
            selector.app || input.procedure.target.name,
            selector.window_title || ''
          );
          break;
        case 'get_focused_input':
          result = bridge.detectFocusedInput();
          break;
        case 'window_list':
          result = bridge.getWindowList(selector.app || input.procedure.target.name);
          break;
        case 'clipboard_read':
          result = { available: true, hash: 'withheld' };
          bridge.clipboardRead();
          break;
        case 'screenshot': {
          const recordingSegment = recording.recording_id.replace(/[^a-zA-Z0-9._-]/g, '_');
          const stepSegment = step.step_id.replace(/[^a-zA-Z0-9._-]/g, '_');
          const screenshotDir = assertSafeRepositoryPath(
            pathResolver.sharedTmp('desktop-screenshots'),
            { allowMissingLeaf: true }
          );
          safeMkdir(screenshotDir, { recursive: true });
          const finalPath = assertSafeRepositoryPath(
            pathResolver.sharedTmp(
              `desktop-screenshots/${recordingSegment}-${stepSegment}-${randomUUID()}.png`
            ),
            { allowMissingLeaf: true }
          );
          const rawPath = assertSafeRepositoryPath(
            pathResolver.sharedTmp(`desktop-screenshots/raw-${randomUUID()}.png`),
            { allowMissingLeaf: true }
          );
          try {
            bridge.takeScreenshot(rawPath);
            await redactScreenshot(rawPath, finalPath);
          } catch (error) {
            safeRmSync(rawPath, { force: true });
            safeRmSync(finalPath, { force: true });
            throw error;
          }
          result = { path: finalPath, redacted: true };
          break;
        }
        case 'mouse_click': {
          const x = selector.x ?? params.x;
          const y = selector.y ?? params.y;
          const clickCount = selector.click_count ?? params.click_count ?? 1;
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isInteger(clickCount)) {
            return {
              status: 'blocked',
              errors: [
                `desktop click step ${step.step_id} contains invalid coordinates or click_count`,
              ],
            };
          }
          result = bridge.clickAt(Number(x), Number(y), Number(clickCount));
          break;
        }
        case 'right_click': {
          const x = selector.x ?? params.x;
          const y = selector.y ?? params.y;
          const clickCount = selector.click_count ?? params.click_count ?? 1;
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isInteger(clickCount)) {
            return {
              status: 'blocked',
              errors: [
                `desktop right_click step ${step.step_id} contains invalid coordinates or click_count`,
              ],
            };
          }
          result = bridge.rightClickAt(Number(x), Number(y), Number(clickCount));
          break;
        }
        case 'keyboard': {
          const value = desktopText(step, inputs);
          if (value === null)
            return {
              status: 'blocked',
              errors: [
                `desktop text step ${step.step_id} requires a runtime input; raw text is never recorded`,
              ],
            };
          result = bridge.keystrokeText(value);
          break;
        }
        case 'paste_text': {
          const value = desktopText(step, inputs);
          if (value === null)
            return {
              status: 'blocked',
              errors: [
                `desktop paste step ${step.step_id} requires a runtime input; raw text is never recorded`,
              ],
            };
          result = bridge.pasteText(value);
          break;
        }
        case 'press_key': {
          const keyCode = Number(params.key_code);
          if (
            !Number.isInteger(keyCode) ||
            keyCode < 0 ||
            keyCode > 65_535 ||
            typeof bridge.pressKeyCode !== 'function'
          ) {
            return {
              status: 'blocked',
              errors: [
                `desktop press_key step ${step.step_id} requires a validated native key_code`,
              ],
            };
          }
          result = bridge.pressKeyCode(keyCode);
          break;
        }
        case 'app_quit':
          result = bridge.quitApplication(selector.app || input.procedure.target.name);
          break;
        case 'system_notify':
          result = bridge.systemNotify('Kyberion', String(params.message || step.summary));
          break;
        default:
          return { status: 'blocked', errors: [`unsupported desktop op: ${op}`] };
      }
      results.push({ step_id: step.step_id, op, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: 'blocked',
        errors: [`desktop ${op} failed: ${message}`],
        serviceResults: results as ServiceStepResult[],
      };
    }
  }
  return { status: 'executed', serviceResults: results as ServiceStepResult[], errors: [] };
}

// ---------------------------------------------------------------------------
// Browser / extension_session executor
// ---------------------------------------------------------------------------

function dispatchExtensionSession(input: DispatchInput): DispatchResult {
  const { procedure, recording, session, agentId, channel, correlationId } = input;

  if (!recording) {
    recordGovernanceAction(agentId, 'procedure_dispatcher', 'missing_recording', true);
    return {
      status: 'blocked',
      errors: ['extension_session executor requires a recording'],
    };
  }
  if (!session) {
    recordGovernanceAction(agentId, 'procedure_dispatcher', 'missing_session', true);
    return {
      status: 'blocked',
      errors: ['extension_session executor requires a session'],
    };
  }

  // Origin guard: every origin the recording touches (each segment) must be in
  // the procedure's approved allowed-origins set.
  const segments = segmentRecording(recording);
  if (procedure.target.origins && procedure.target.origins.length > 0) {
    for (const segment of segments) {
      const allowed = procedure.target.origins.some((o) => matchesAllowedOrigin(o, segment.origin));
      if (!allowed) {
        recordGovernanceAction(
          agentId,
          'procedure_dispatcher',
          `origin_blocked:${procedure.procedure_id}`,
          true
        );
        return {
          status: 'blocked',
          errors: [
            `Segment origin "${segment.origin}" is not in allowed origins for ` +
              `procedure "${procedure.procedure_id}": [${procedure.target.origins.join(', ')}]`,
          ],
        };
      }
    }
  }

  // Enforce the approval gate (synchronous — reads the approval store). A single
  // approval covers all high-risk steps across every segment. The correlation key
  // is procedure-scoped and stable, independent of the synthetic mission_id, so
  // the same approval is found regardless of entry point (review finding AR-M4).
  const approval = enforceBrowserExtensionApproval({
    recording,
    session,
    agentId,
    channel: channel ?? 'browser-extension',
    correlationId: correlationId ?? `procedure:${procedure.procedure_id}:${recording.recording_id}`,
    ...(input.hasHuman !== undefined ? { hasHuman: input.hasHuman } : {}),
    ...(input.hasUI !== undefined ? { hasUI: input.hasUI } : {}),
    ...(input.nonInteractive !== undefined ? { nonInteractive: input.nonInteractive } : {}),
  });

  if (!approval.allowed) {
    logger.info(
      `[procedure-dispatcher] approval required for "${procedure.procedure_id}" ` +
        `— request_id=${approval.requestId ?? 'n/a'}`
    );
    recordGovernanceAction(
      agentId,
      'procedure_dispatcher',
      `approval_required:${procedure.procedure_id}`,
      true
    );
    return {
      status: 'approval_required',
      approvalRequestId: approval.requestId,
      errors: [],
    };
  }

  // --- Multi-origin (segmented): one origin-bound lease per segment ---------
  if (segments.length > 1) {
    const issued = issueSegmentedLeases({ recording, session, approval });
    if (issued.errors.length > 0 || !issued.leases) {
      return {
        status: 'blocked',
        errors: issued.errors.length > 0 ? issued.errors : ['segmented lease issuance failed'],
      };
    }
    // Authoritative per-segment execute-mode preflight: each segment's
    // sub-recording validated against its own origin-bound lease (origin /
    // recording_id / expiry / step-hash coverage). Any blocked segment fails all.
    for (const seg of issued.leases) {
      const segment = segments.find((s) => s.index === seg.segment_index);
      if (!segment) {
        return {
          status: 'blocked',
          errors: [
            `segment ${seg.segment_index} (${seg.origin}): segment not found for issued lease`,
          ],
        };
      }
      const sub = subRecordingForSegment(recording, segment);
      const verified = preflightBrowserExtensionSession({
        recording: sub,
        session: { ...session, origin: seg.origin, lease: seg.lease },
        bridgeAvailable: true,
      });
      if (verified.status === 'blocked') {
        return {
          status: 'blocked',
          errors: [`segment ${seg.segment_index} (${seg.origin}): ${verified.errors.join('; ')}`],
        };
      }
    }
    logger.info(
      `[procedure-dispatcher] ${issued.leases.length} segment leases issued for "${procedure.procedure_id}" ` +
        `origins=[${issued.leases.map((s) => s.origin).join(', ')}]`
    );
    return { status: 'lease_issued', segments: issued.leases, errors: [] };
  }

  // --- Single-origin --------------------------------------------------------
  const issued = issueBrowserExtensionLease({ recording, session, approval });
  if (issued.errors.length > 0 || !issued.lease) {
    return {
      status: 'blocked',
      errors: issued.errors.length > 0 ? issued.errors : ['lease issuance failed unexpectedly'],
    };
  }

  logger.info(
    `[procedure-dispatcher] lease issued for "${procedure.procedure_id}" ` +
      `origin="${recording.tab.origin}" lease="${issued.lease.lease_id}"`
  );
  return { status: 'lease_issued', lease: issued.lease, errors: [] };
}

// ---------------------------------------------------------------------------
// Browser / playwright executor (execution_substrate: 'playwright')
// Design: docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md §4/§7 Layer③
// ---------------------------------------------------------------------------

async function dispatchPlaywrightPipeline(input: DispatchInput): Promise<DispatchResult> {
  const { procedure, recording, session, agentId, channel, correlationId } = input;

  if (!recording) {
    recordGovernanceAction(agentId, 'procedure_dispatcher', 'missing_recording', true);
    return {
      status: 'blocked',
      errors: ['playwright executor requires a recording'],
    };
  }
  if (recording.review?.status !== 'approved') {
    recordGovernanceAction(
      agentId,
      'procedure_dispatcher',
      'playwright_unapproved_recording',
      true
    );
    return {
      status: 'blocked',
      errors: ['playwright execution requires an approved recording review'],
    };
  }

  // Same origin guard as dispatchExtensionSession: every origin the recording
  // touches must be in the procedure's approved allowed-origins set.
  const segments = segmentRecording(recording);
  if (procedure.target.origins && procedure.target.origins.length > 0) {
    for (const segment of segments) {
      const allowed = procedure.target.origins.some((o) => matchesAllowedOrigin(o, segment.origin));
      if (!allowed) {
        recordGovernanceAction(
          agentId,
          'procedure_dispatcher',
          `origin_blocked:${procedure.procedure_id}`,
          true
        );
        return {
          status: 'blocked',
          errors: [
            `Segment origin "${segment.origin}" is not in allowed origins for ` +
              `procedure "${procedure.procedure_id}": [${procedure.target.origins.join(', ')}]`,
          ],
        };
      }
    }
  }

  // Same substrate-agnostic approval gate as the extension path: a clean ref
  // resolution says nothing about whether a high-risk action should auto-run.
  const approval = enforceBrowserExtensionApproval({
    recording,
    session: session ?? {
      kind: 'browser-extension-session.v1',
      mission_id: input.missionId,
      pipeline_id: input.pipelineId ?? procedure.pipeline_ref,
      tab_id: '',
      origin: recording.tab.origin,
      mode: 'execute',
      recording_id: recording.recording_id,
      requested_operations: [],
    },
    agentId,
    channel: channel ?? 'browser-playwright',
    correlationId: correlationId ?? `procedure:${procedure.procedure_id}:${recording.recording_id}`,
    ...(input.hasHuman !== undefined ? { hasHuman: input.hasHuman } : {}),
    ...(input.hasUI !== undefined ? { hasUI: input.hasUI } : {}),
    ...(input.nonInteractive !== undefined ? { nonInteractive: input.nonInteractive } : {}),
  });

  if (!approval.allowed) {
    logger.info(
      `[procedure-dispatcher] approval required for "${procedure.procedure_id}" ` +
        `— request_id=${approval.requestId ?? 'n/a'}`
    );
    recordGovernanceAction(
      agentId,
      'procedure_dispatcher',
      `approval_required:${procedure.procedure_id}`,
      true
    );
    return {
      status: 'approval_required',
      approvalRequestId: approval.requestId,
      errors: [],
    };
  }

  if (!input.executeBrowserPipeline) {
    recordGovernanceAction(
      agentId,
      'procedure_dispatcher',
      'playwright_no_executor_injected',
      true
    );
    return {
      status: 'blocked',
      errors: [
        'playwright executor requires an injected executeBrowserPipeline ' +
          '(wire in @agent/browser-actuator handleAction at the call site)',
      ],
    };
  }

  const draft = compileBrowserRecordingToPipeline(recording, {
    pipelineId: input.pipelineId,
    executionSubstrate: 'playwright',
  });

  try {
    const exec = await input.executeBrowserPipeline({
      steps: draft.steps,
      sessionId: session?.tab_id,
      options: draft.options,
    });
    if (exec.status !== 'succeeded') {
      const errors =
        exec.errors && exec.errors.length > 0 ? exec.errors : [`browser execution ${exec.status}`];
      logger.warn(
        `[procedure-dispatcher] playwright procedure "${procedure.procedure_id}" failed: ${errors.join('; ')}`
      );
      recordGovernanceAction(
        agentId,
        'procedure_dispatcher',
        `playwright_execution_failed:${procedure.procedure_id}`,
        true
      );
      return { status: 'blocked', browserResults: exec.results, errors };
    }
    logger.info(
      `[procedure-dispatcher] playwright procedure "${procedure.procedure_id}" executed (${draft.steps.length} steps)`
    );
    return { status: 'executed', browserResults: exec.results, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[procedure-dispatcher] playwright procedure "${procedure.procedure_id}" threw during execution: ${message}`
    );
    recordGovernanceAction(
      agentId,
      'procedure_dispatcher',
      `playwright_execution_error:${procedure.procedure_id}`,
      true
    );
    return {
      status: 'blocked',
      errors: [message],
    };
  }
}

// ---------------------------------------------------------------------------
// Service / service:preset executor (Agent-S3)
// Design: docs/INTENT_DRIVEN_SERVICE_AUTOMATION_DESIGN.ja.md §7-C
// ---------------------------------------------------------------------------

async function dispatchServiceSession(input: DispatchInput): Promise<DispatchResult> {
  const {
    procedure,
    serviceRecording,
    agentId,
    channel,
    correlationId,
    hasHuman,
    hasUI,
    nonInteractive,
  } = input;

  if (!serviceRecording) {
    recordGovernanceAction(agentId, 'procedure_dispatcher', 'service_missing_recording', true);
    return { status: 'blocked', errors: ['service:preset executor requires a serviceRecording'] };
  }
  const recordingValidation = validateServiceRecording(serviceRecording);
  if (!recordingValidation.value) {
    recordGovernanceAction(agentId, 'procedure_dispatcher', 'service_invalid_recording', true);
    return {
      status: 'blocked',
      errors: [`service recording failed validation: ${recordingValidation.errors.join('; ')}`],
    };
  }
  if (serviceRecording.review?.status !== 'approved') {
    recordGovernanceAction(agentId, 'procedure_dispatcher', 'service_unapproved_recording', true);
    return {
      status: 'blocked',
      errors: ['service execution requires an approved recording review'],
    };
  }

  // Service guard: every step's service_id must be in the procedure's allowed set.
  const allowedServices = procedure.target.services ?? [];
  if (allowedServices.length > 0) {
    for (const step of serviceRecording.steps) {
      if (!allowedServices.includes(step.service_id)) {
        recordGovernanceAction(
          agentId,
          'procedure_dispatcher',
          `service_blocked:${procedure.procedure_id}`,
          true
        );
        return {
          status: 'blocked',
          errors: [
            `step ${step.step_id} uses service "${step.service_id}" not in allowed services [${allowedServices.join(', ')}]`,
          ],
        };
      }
    }
  }

  // External-effect (high-risk) steps must pass the approval gate — read-only
  // compositions run ungated. A single approval covers all external effects.
  const externalEffectSteps = serviceRecording.steps.filter(isExternalEffectStep);
  if (externalEffectSteps.length > 0) {
    const approval = enforceApprovalGate({
      intentId: SERVICE_EXTERNAL_EFFECT_OP,
      operationId: SERVICE_EXTERNAL_EFFECT_OP,
      agentId,
      correlationId:
        correlationId ?? `procedure:${procedure.procedure_id}:${serviceRecording.recording_id}`,
      channel: channel ?? 'service',
      payload: {
        services: allowedServices,
        operations: externalEffectSteps.map((s) => `${s.service_id}.${s.action}`),
      },
      draft: {
        title: `Service 実行: ${procedure.target.name}`,
        summary: `${externalEffectSteps.length} 件の external-effect（${externalEffectSteps.map((s) => `${s.service_id}.${s.action}`).join(', ')}）`,
        severity: 'high',
      },
      ...(hasHuman !== undefined ? { hasHuman } : {}),
      ...(hasUI !== undefined ? { hasUI } : {}),
      ...(nonInteractive !== undefined ? { nonInteractive } : {}),
    });
    if (!approval.allowed) {
      logger.info(
        `[procedure-dispatcher] service approval required for "${procedure.procedure_id}" — request_id=${approval.requestId ?? 'n/a'}`
      );
      recordGovernanceAction(
        agentId,
        'procedure_dispatcher',
        `service_approval_required:${procedure.procedure_id}`,
        true
      );
      return { status: 'approval_required', approvalRequestId: approval.requestId, errors: [] };
    }
  }

  const exec = await executeServiceProcedure({
    recording: serviceRecording,
    inputs: input.serviceInputs,
    externalEffectApproved: true,
    executePreset: input.executePreset,
  });

  if (exec.status === 'completed') {
    logger.info(
      `[procedure-dispatcher] service procedure "${procedure.procedure_id}" executed (${exec.results.length} steps)`
    );
    return { status: 'executed', serviceResults: exec.results, errors: [] };
  }
  const failed = exec.results.find((r) => r.status === 'error' || r.status === 'blocked');
  return {
    status: 'blocked',
    serviceResults: exec.results,
    errors: [
      failed
        ? `step ${failed.step_id} ${failed.status}: ${failed.detail ?? ''}`
        : `service execution ${exec.status}`,
    ],
  };
}
