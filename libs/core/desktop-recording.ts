import { createHash, randomUUID } from 'node:crypto';
import AjvModule, { type ValidateFunction } from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import type { FocusedInputState } from './apple-event-bridge.js';
import type { OsAutomationBridge } from './os-automation-bridge.js';
import type { MacOSAutomationProbe } from './macos-automation-bridge.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { redactSensitiveString } from './network.js';
import { scrubContent } from './pii-scrubber.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
let desktopRecordingValidator: ValidateFunction | null = null;

export type DesktopObservationTier = 0 | 1 | 3;
export type DesktopObservationCost = 'low' | 'medium' | 'high';

export interface DesktopObservationSource {
  id: 'active_window' | 'clipboard' | 'browser_tabs' | 'focused_input' | 'screen_frame';
  observation_tier: DesktopObservationTier;
  cost: DesktopObservationCost;
  permission: 'none' | 'accessibility' | 'screen_recording';
  captures: string;
}

/** This axis is intentionally not the personal/confidential/public data tier. */
export const DESKTOP_OBSERVATION_SOURCES: readonly DesktopObservationSource[] = [
  {
    id: 'active_window',
    observation_tier: 1,
    cost: 'low',
    permission: 'accessibility',
    captures: 'application and window title',
  },
  {
    id: 'clipboard',
    observation_tier: 0,
    cost: 'low',
    permission: 'none',
    captures: 'sha256 and bounded preview only',
  },
  {
    id: 'browser_tabs',
    observation_tier: 1,
    cost: 'medium',
    permission: 'accessibility',
    captures: 'active tab host and title',
  },
  {
    id: 'focused_input',
    observation_tier: 1,
    cost: 'low',
    permission: 'accessibility',
    captures: 'AX role, description, and editable state',
  },
  {
    id: 'screen_frame',
    observation_tier: 3,
    cost: 'high',
    permission: 'screen_recording',
    captures: 'redaction-pending frame reference',
  },
];

export interface DesktopRecordingTarget {
  name: string;
  platform: NodeJS.Platform;
  app?: string;
}

export interface DesktopRecordingStep {
  step_id: string;
  op: string;
  summary: string;
  risk_class: 'read' | 'low' | 'high';
  selector?: {
    app?: string;
    window_title?: string;
    role?: string;
    description?: string;
    editable?: boolean;
    x?: number;
    y?: number;
    click_count?: number;
  };
  variable?: { name: string; classification: 'user_input' | 'secret_ref' };
  params?: Record<string, unknown>;
  /** Explicit, reviewed native execution binding; never inferred from UI text. */
  native_op?: string;
  evidence: string[];
  frame_ref?: string;
  needs_semantic_resolution?: boolean;
}

export interface DesktopRecordingScreenArtifact {
  status: 'succeeded' | 'unavailable';
  recording_ref?: string;
  sha256?: string;
  frame_count?: number;
  fps?: number;
  reason?: string;
}

export interface DesktopRecordingCaptureSummary {
  event_source: 'native-cg-event-tap' | 'state-observation-only';
  status: 'active' | 'unavailable';
  reason?: string;
}

export interface DesktopRecording {
  schema_version: 'desktop-recording.v1';
  recording_id: string;
  source: 'desktop-capture';
  created_at: string;
  target: DesktopRecordingTarget;
  steps: DesktopRecordingStep[];
  risk_summary: { requires_manual_review: boolean; approval_required_count: number };
  /** Hash of the generated intent source, excluding the mutable review decision. */
  intent_hash?: string;
  recording_hash: string;
  policy_version: string;
  review: {
    status: 'pending' | 'approved' | 'rejected';
    reviewed_at?: string;
    reviewer?: string;
    note?: string;
  };
  capture?: DesktopRecordingCaptureSummary;
  artifacts?: { screen_recording?: DesktopRecordingScreenArtifact };
}

export interface DesktopRecordingValidationResult {
  valid: boolean;
  errors: string[];
  value?: DesktopRecording;
}

function getDesktopRecordingValidator(): ValidateFunction {
  if (!desktopRecordingValidator) {
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    desktopRecordingValidator = compileSchemaFromPath(
      ajv,
      pathResolver.knowledge('product/schemas/desktop-recording.schema.json')
    );
  }
  return desktopRecordingValidator;
}

/** Validate the persisted desktop recording before it reaches intent or execution. */
export function validateDesktopRecording(input: unknown): DesktopRecordingValidationResult {
  const validate = getDesktopRecordingValidator();
  if (!validate(input)) {
    return {
      valid: false,
      errors: (validate.errors || []).map(
        (error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`
      ),
    };
  }
  const recording = input as DesktopRecording;
  const errors: string[] = [];
  const highRiskCount = recording.steps.filter((step) => step.risk_class === 'high').length;
  if (!recording.risk_summary.requires_manual_review) {
    errors.push('desktop recordings must require manual review');
  }
  if (recording.risk_summary.approval_required_count !== highRiskCount) {
    errors.push('risk_summary.approval_required_count must match high-risk steps');
  }
  if (recording.recording_hash !== computeDesktopRecordingHash(recording)) {
    errors.push('recording_hash does not match the reviewed recording body');
  }
  const screenArtifact = recording.artifacts?.screen_recording;
  if (screenArtifact?.status === 'succeeded') {
    if (!screenArtifact.recording_ref)
      errors.push('successful screen recording requires recording_ref');
    if (!/^[a-f0-9]{64}$/iu.test(screenArtifact.sha256 || '')) {
      errors.push('successful screen recording requires a sha256 digest');
    }
    if (!Number.isInteger(screenArtifact.frame_count) || (screenArtifact.frame_count || 0) < 1) {
      errors.push('successful screen recording requires a positive frame_count');
    }
  }
  for (const [label, value] of [
    ['target.name', recording.target.name],
    ['target.app', recording.target.app],
    ['capture.reason', recording.capture?.reason],
    ['screen_recording.reason', screenArtifact?.reason],
  ] as const) {
    if (value !== undefined && safeObservedText(value) !== value)
      errors.push(`${label} contains unsanitized observation text`);
  }
  if (recording.intent_hash !== undefined && !/^[a-f0-9]{64}$/iu.test(recording.intent_hash)) {
    errors.push('intent_hash must be a sha256 digest');
  }
  const stepIds = new Set<string>();
  for (const step of recording.steps) {
    if (stepIds.has(step.step_id)) errors.push(`duplicate step_id ${step.step_id}`);
    stepIds.add(step.step_id);
    const selectorText = [
      step.selector?.app,
      step.selector?.window_title,
      step.selector?.role,
      step.selector?.description,
    ].filter((value): value is string => typeof value === 'string');
    for (const value of [step.summary, ...selectorText, ...step.evidence]) {
      if (safeObservedText(value) !== value)
        errors.push(`step ${step.step_id} contains unsanitized observation text`);
    }
    if (
      step.native_op !== undefined &&
      !/^[a-z][a-z0-9_-]{0,31}:[a-z0-9][a-z0-9_:-]{1,119}$/iu.test(step.native_op)
    ) {
      errors.push(`step ${step.step_id} contains an invalid native_op`);
    }
    const selector = step.selector;
    for (const key of ['app', 'window_title', 'role', 'description'] as const) {
      const value = selector?.[key];
      if (
        value !== undefined &&
        (typeof value !== 'string' || value.length > 240 || safeObservedText(value) !== value)
      ) {
        errors.push(`step ${step.step_id} contains an invalid selector.${key}`);
      }
    }
    for (const key of ['x', 'y'] as const) {
      const value = selector?.[key];
      if (value !== undefined && safeCoordinate(value) === undefined)
        errors.push(`step ${step.step_id} contains an invalid selector.${key}`);
    }
    if (
      (step.op === 'mouse_click' || step.op === 'right_click') &&
      (safeCoordinate(selector?.x) === undefined || safeCoordinate(selector?.y) === undefined)
    ) {
      errors.push(`step ${step.step_id} requires finite x/y coordinates`);
    }
    if (
      selector?.click_count !== undefined &&
      (!Number.isInteger(selector.click_count) ||
        selector.click_count < 1 ||
        selector.click_count > 3)
    ) {
      errors.push(`step ${step.step_id} contains an invalid selector.click_count`);
    }
    if (step.params) {
      const keys = Object.keys(step.params);
      if (step.op !== 'press_key' || keys.some((key) => key !== 'key_code')) {
        errors.push(`step ${step.step_id} contains non-allowlisted event parameters`);
      } else if (
        !Number.isInteger(step.params.key_code) ||
        Number(step.params.key_code) < 0 ||
        Number(step.params.key_code) > 65_535
      ) {
        errors.push(`step ${step.step_id} contains an invalid key_code`);
      }
    }
    if (
      step.frame_ref &&
      (!/^[a-zA-Z0-9._/-]{1,240}$/.test(step.frame_ref) || step.frame_ref.includes('..'))
    ) {
      errors.push(`step ${step.step_id} contains an invalid frame_ref`);
    }
  }
  return errors.length > 0
    ? { valid: false, errors }
    : { valid: true, errors: [], value: recording };
}

export interface DesktopObservationSnapshot {
  observed_at?: string;
  application?: string;
  window_title?: string;
  focused_input?: FocusedInputState;
  clipboard_text?: string;
  clipboard_hash?: string;
  browser_host?: string;
  browser_title?: string;
  frame_hash?: string;
  frame_ref?: string;
  event?: {
    op: string;
    params?: Record<string, unknown>;
    x?: number;
    y?: number;
    click_count?: number;
  };
}

export type DesktopEvent = NonNullable<DesktopObservationSnapshot['event']>;
export type DesktopEventSource = () => DesktopEvent | readonly DesktopEvent[] | undefined;

const READ_ONLY_OPS = new Set([
  'screenshot',
  'get_focused_input',
  'window_list',
  'clipboard_read',
  'chrome_tab_list',
  'wait_for_element',
]);
const RECORDED_OP_ALIASES: Record<string, string> = {
  click_at: 'mouse_click',
  right_click_at: 'right_click',
  keystroke_text: 'keyboard',
};
const HIGH_RISK_OPS = new Set([
  'app_quit',
  'process_kill',
  'press_key',
  'paste_text',
  'keyboard',
  'click_element',
  'mouse_click',
  'right_click',
  'delete',
  'submit',
]);
const RECORDED_EVENT_OPS = new Set([
  'activate_application',
  'activate_window_by_title',
  'click_at',
  'right_click_at',
  'keystroke_text',
  'paste_text',
  'press_key',
  'app_quit',
  'process_kill',
  'screenshot',
  'get_focused_input',
  'window_list',
  'clipboard_read',
  'chrome_tab_list',
  'wait_for_element',
]);

function safeObservedText(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const scrubbed = scrubContent(value).scrubbed_text;
  return redactSensitiveString(scrubbed).slice(0, maxLength);
}

export function sanitizeDesktopObservationText(
  value: unknown,
  maxLength = 240
): string | undefined {
  return safeObservedText(value, maxLength);
}

function safeCoordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100_000
    ? value
    : undefined;
}

function safeEvent(
  snapshot: DesktopObservationSnapshot
): DesktopObservationSnapshot['event'] | undefined {
  const event = snapshot.event;
  if (!event || !RECORDED_EVENT_OPS.has(event.op)) return undefined;
  const x = safeCoordinate(event.x);
  const y = safeCoordinate(event.y);
  const clickCount =
    typeof event.click_count === 'number' &&
    Number.isInteger(event.click_count) &&
    event.click_count >= 1 &&
    event.click_count <= 3
      ? event.click_count
      : undefined;
  if (event.op === 'press_key') {
    const keyCode = event.params?.key_code;
    if (
      typeof keyCode !== 'number' ||
      !Number.isInteger(keyCode) ||
      keyCode < 0 ||
      keyCode > 65_535
    )
      return undefined;
    return { op: event.op, params: { key_code: keyCode } };
  }
  return {
    op: event.op,
    ...(x !== undefined ? { x } : {}),
    ...(y !== undefined ? { y } : {}),
    ...(clickCount !== undefined ? { click_count: clickCount } : {}),
  };
}

function recordingBody(
  recording: Pick<
    DesktopRecording,
    'schema_version' | 'target' | 'steps' | 'capture' | 'artifacts' | 'intent_hash'
  >
): object {
  return {
    schema_version: recording.schema_version,
    target: recording.target,
    steps: recording.steps,
    ...(recording.intent_hash ? { intent_hash: recording.intent_hash } : {}),
    ...(recording.capture ? { capture: recording.capture } : {}),
    ...(recording.artifacts ? { artifacts: recording.artifacts } : {}),
  };
}

export function computeDesktopRecordingHash(
  recording: Pick<
    DesktopRecording,
    'schema_version' | 'target' | 'steps' | 'capture' | 'artifacts' | 'intent_hash'
  >
): string {
  return createHash('sha256')
    .update(JSON.stringify(recordingBody(recording)))
    .digest('hex');
}

function clipboardEvidence(value: string | undefined, knownHash?: string): string[] {
  if (!value) return [];
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return [`clipboard:sha256:${digest}`, 'clipboard:preview:withheld'];
}

function stepFrom(snapshot: DesktopObservationSnapshot): DesktopRecordingStep | null {
  const event = safeEvent(snapshot);
  if (!event?.op) return null;
  const operation = RECORDED_OP_ALIASES[event.op] || event.op;
  const focused = snapshot.focused_input;
  const selector = {
    ...(safeObservedText(snapshot.application)
      ? { app: safeObservedText(snapshot.application) }
      : {}),
    ...(safeObservedText(snapshot.window_title || focused?.windowTitle)
      ? { window_title: safeObservedText(snapshot.window_title || focused?.windowTitle) }
      : {}),
    ...(safeObservedText(focused?.role, 80) ? { role: safeObservedText(focused?.role, 80) } : {}),
    ...(safeObservedText(focused?.description)
      ? { description: safeObservedText(focused?.description) }
      : {}),
    ...(typeof focused?.editable === 'boolean' ? { editable: focused.editable } : {}),
    ...(event.x !== undefined ? { x: event.x } : {}),
    ...(event.y !== undefined ? { y: event.y } : {}),
    ...(event.click_count !== undefined ? { click_count: event.click_count } : {}),
  };
  const semantic = Boolean(
    selector.app || selector.window_title || selector.role || selector.description
  );
  return {
    step_id: `desktop-step-${randomUUID().slice(0, 8)}`,
    op: operation,
    summary: `${operation} in ${selector.app || selector.window_title || 'desktop target'}`,
    risk_class: HIGH_RISK_OPS.has(operation)
      ? 'high'
      : READ_ONLY_OPS.has(operation)
        ? 'read'
        : 'low',
    selector,
    ...(event.params ? { params: { key_code: event.params.key_code } } : {}),
    evidence: [
      ...(selector.app ? ['active_window:application'] : []),
      ...(selector.window_title ? ['active_window:window_title'] : []),
      ...(selector.role || selector.description ? ['focused_input:accessibility'] : []),
      ...clipboardEvidence(snapshot.clipboard_text, snapshot.clipboard_hash),
      ...(snapshot.clipboard_hash && !snapshot.clipboard_text
        ? [`clipboard:sha256:${snapshot.clipboard_hash}`]
        : []),
      ...(safeObservedText(snapshot.browser_host, 253)
        ? [`browser_tabs:host:${safeObservedText(snapshot.browser_host, 253)}`]
        : []),
    ],
    ...(event.x !== undefined || event.y !== undefined
      ? { needs_semantic_resolution: !semantic }
      : {}),
    ...(snapshot.frame_ref && /^[a-zA-Z0-9._/-]{1,240}$/.test(snapshot.frame_ref)
      ? { frame_ref: snapshot.frame_ref }
      : {}),
  };
}

/** Build a recording from OS observations; no Kyberion action hook is required. */
export function buildDesktopRecording(
  snapshots: readonly DesktopObservationSnapshot[],
  options: {
    recordingId?: string;
    platform?: NodeJS.Platform;
    targetName?: string;
    policyVersion?: string;
    review?: DesktopRecording['review'];
  } = {}
): DesktopRecording {
  const steps: DesktopRecordingStep[] = [];
  let lastApp = '';
  let lastHost = '';
  let lastFrame = '';
  for (const snapshot of snapshots) {
    const event = snapshot.event;
    if (!event) continue;
    const boundary =
      event.op === 'activate_application' ||
      event.op === 'activate_window_by_title' ||
      (snapshot.application && snapshot.application !== lastApp) ||
      (snapshot.browser_host && snapshot.browser_host !== lastHost) ||
      (snapshot.frame_hash && snapshot.frame_hash !== lastFrame);
    if (
      !boundary &&
      ![
        'click_at',
        'right_click_at',
        'keystroke_text',
        'paste_text',
        'press_key',
        'app_quit',
        'process_kill',
      ].includes(event.op)
    )
      continue;
    const step = stepFrom(snapshot);
    if (!step) continue;
    steps.push(step);
    lastApp = snapshot.application || lastApp;
    lastHost = snapshot.browser_host || lastHost;
    lastFrame = snapshot.frame_hash || lastFrame;
  }
  const body = {
    schema_version: 'desktop-recording.v1' as const,
    target: {
      name: safeObservedText(options.targetName) || 'desktop',
      platform: options.platform || process.platform,
    },
    steps,
  };
  const highRisk = steps.filter((step) => step.risk_class === 'high').length;
  return {
    ...body,
    recording_id: options.recordingId || `DR-${randomUUID()}`,
    source: 'desktop-capture',
    created_at: new Date().toISOString(),
    // A recording is a human demonstration artifact even when every observed
    // step is read-only. Promotion and execution must still pass review.
    risk_summary: { requires_manual_review: true, approval_required_count: highRisk },
    recording_hash: computeDesktopRecordingHash(body),
    policy_version: options.policyVersion || 'desktop-policy.v1',
    review: options.review || { status: 'pending' },
  };
}

export function reviewDesktopRecording(
  recording: DesktopRecording,
  decision: 'approved' | 'rejected',
  reviewer: string,
  note?: string
): DesktopRecording {
  return {
    ...recording,
    review: {
      status: decision,
      reviewed_at: new Date().toISOString(),
      reviewer,
      ...(note ? { note } : {}),
    },
  };
}

export function listDesktopObservationSources(): DesktopObservationSource[] {
  return DESKTOP_OBSERVATION_SOURCES.map((source) => ({ ...source }));
}

export interface DesktopObservationReadiness {
  source_id: DesktopObservationSource['id'];
  available: boolean;
  reason: string;
}

/**
 * Resolve the observation registry against the host permission probe. The
 * result is deliberately descriptive: unavailable sources are surfaced with
 * a reason instead of silently disappearing from a recording.
 */
export function assessDesktopObservationReadiness(
  probe: Pick<MacOSAutomationProbe, 'platform' | 'available' | 'permissions'>
): DesktopObservationReadiness[] {
  return DESKTOP_OBSERVATION_SOURCES.map((source) => {
    if (source.permission === 'none') {
      return { source_id: source.id, available: true, reason: 'permission_not_required' };
    }
    if (probe.platform !== 'darwin') {
      return {
        source_id: source.id,
        available: false,
        reason: `macos_only_capability:${probe.platform}`,
      };
    }
    if (!probe.available) {
      return {
        source_id: source.id,
        available: false,
        reason: 'automation_bridge_unavailable',
      };
    }
    const permission = probe.permissions[source.permission];
    return permission === 'granted'
      ? { source_id: source.id, available: true, reason: 'permission_granted' }
      : {
          source_id: source.id,
          available: false,
          reason: `${source.permission}_permission_${permission}`,
        };
  });
}

/** Default host sampler backed only by existing OS observation primitives. */
export function sampleDesktopObservation(
  bridge: OsAutomationBridge = {} as OsAutomationBridge
): DesktopObservationSnapshot {
  const focused = bridge.detectFocusedInput();
  const tabs = focused.application.toLowerCase().includes('chrome') ? bridge.listChromeTabs() : [];
  const clipboard = bridge.clipboardRead();
  return {
    application: focused.application,
    window_title: focused.windowTitle,
    focused_input: focused,
    clipboard_hash: createHash('sha256').update(clipboard).digest('hex').slice(0, 16),
    browser_host: tabs[0]?.url
      ? (() => {
          try {
            return new URL(tabs[0].url).host;
          } catch {
            return undefined;
          }
        })()
      : undefined,
    browser_title: tabs[0]?.title,
  };
}

export interface DesktopRecorderOptions {
  sample: () => DesktopObservationSnapshot;
  /** Host-owned OS event feed. Without it, only observable app/window transitions can be inferred. */
  eventSource?: DesktopEventSource;
  now?: () => string;
  baseIntervalMs?: number;
  browserIntervalMs?: number;
  heartbeatMs?: number;
}

/**
 * Polling recorder for human demonstrations. It observes OS state and accepts
 * event observations from the host surface; it never calls Kyberion's executor.
 * The timer is intentionally owned by the caller so tests and foreground
 * surfaces can stop it without a process-global singleton.
 */
export class DesktopDemonstrationRecorder {
  private readonly samples: DesktopObservationSnapshot[] = [];
  private lastFrameHash = '';
  private lastFrameAt = 0;
  private lastSampleAt = 0;
  private running = false;
  private readonly now: () => string;
  private readonly baseIntervalMs: number;
  private readonly browserIntervalMs: number;
  private readonly heartbeatMs: number;
  private lastApplication = '';
  private lastWindowTitle = '';
  private lastBrowserHost = '';

  constructor(private readonly options: DesktopRecorderOptions) {
    this.now = options.now || (() => new Date().toISOString());
    this.baseIntervalMs = options.baseIntervalMs || 1000;
    this.browserIntervalMs = options.browserIntervalMs || 1500;
    this.heartbeatMs = options.heartbeatMs || 5000;
  }

  start(): void {
    this.running = true;
    this.lastSampleAt = 0;
    this.lastFrameAt = 0;
    this.lastApplication = '';
    this.lastWindowTitle = '';
    this.lastBrowserHost = '';
  }

  stop(): DesktopRecording {
    this.running = false;
    return buildDesktopRecording(this.samples);
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Returns the next suggested poll delay; browser observation is deliberately slower. */
  nextIntervalMs(snapshot: DesktopObservationSnapshot = this.options.sample()): number {
    return snapshot.browser_host ? this.browserIntervalMs : this.baseIntervalMs;
  }

  pollOnce(atMs = Date.now()): DesktopObservationSnapshot | null {
    if (!this.running) return null;
    const sampled = this.options.sample();
    const sourcedEvents = sampled.event
      ? [sampled.event]
      : (() => {
          const sourced = this.options.eventSource?.();
          if (Array.isArray(sourced)) return sourced;
          return sourced ? [sourced] : [];
        })();
    const inferredEvent =
      sampled.application && sampled.application !== this.lastApplication
        ? { op: 'activate_application' }
        : sampled.window_title && sampled.window_title !== this.lastWindowTitle
          ? { op: 'activate_window_by_title' }
          : undefined;
    const events: Array<DesktopObservationSnapshot['event']> =
      sourcedEvents.length > 0 ? sourcedEvents : [inferredEvent];
    const frameChanged = Boolean(sampled.frame_hash && sampled.frame_hash !== this.lastFrameHash);
    const heartbeatDue = atMs - this.lastFrameAt >= this.heartbeatMs;
    const shouldKeepFrame = frameChanged || heartbeatDue;
    let firstSnapshot: DesktopObservationSnapshot | null = null;
    for (const [index, event] of events.entries()) {
      const includeFrame = index === 0 && (!sampled.frame_hash || shouldKeepFrame);
      const eventful = Boolean(event && !READ_ONLY_OPS.has(event.op));
      const source = includeFrame
        ? sampled
        : { ...sampled, frame_hash: undefined, frame_ref: undefined };
      const rawSnapshot = { ...source, ...(event ? { event } : {}), observed_at: this.now() };
      const snapshot = {
        ...rawSnapshot,
        ...(rawSnapshot.clipboard_text
          ? {
              clipboard_hash: createHash('sha256')
                .update(rawSnapshot.clipboard_text)
                .digest('hex')
                .slice(0, 16),
            }
          : {}),
        clipboard_text: undefined,
      };
      if (!eventful && sampled.frame_hash && !shouldKeepFrame) {
        // Static frames do not become linear recording growth, but eventful
        // snapshots above are retained even when the frame itself is static.
        continue;
      }
      if (includeFrame && snapshot.frame_hash) {
        this.lastFrameHash = snapshot.frame_hash;
        this.lastFrameAt = atMs;
      }
      this.lastSampleAt = atMs;
      this.lastApplication = snapshot.application || this.lastApplication;
      this.lastWindowTitle = snapshot.window_title || this.lastWindowTitle;
      this.lastBrowserHost = snapshot.browser_host || this.lastBrowserHost;
      this.samples.push(snapshot);
      firstSnapshot ||= snapshot;
    }
    return firstSnapshot;
  }

  getSamples(): DesktopObservationSnapshot[] {
    return this.samples.map((sample) => ({
      ...sample,
      event: sample.event ? { ...sample.event } : undefined,
    }));
  }
}
