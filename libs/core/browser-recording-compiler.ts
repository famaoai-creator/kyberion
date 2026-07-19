import { createHash } from 'node:crypto';
import {
  type BrowserExtensionAction,
  type BrowserExtensionOperation,
  type BrowserExtensionRecording,
} from './browser-extension-bridge.js';
import {
  type GoldenScenario,
  type GoldenSuccessCondition,
  type ProcedureEntry,
  type ProcedureRiskClass,
} from './procedure-types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A recording action compiled into a stable step descriptor.
 * The `ref` is kept verbatim — the extension executor resolves it at runtime.
 * `role`/`name` are provided for human review and retry hint hints only.
 */
export interface CompiledBrowserStep {
  step_index: number;
  op: BrowserExtensionOperation;
  ref?: string;
  role?: string;
  name?: string;
  snapshot_hash?: string;
  /** Structural anchor for positional fallback (see BrowserExtensionAction.target.dom_path). */
  dom_path?: string;
  variable?: { name: string; classification: 'user_input' | 'secret_ref' };
  selection?: { kind: 'option' | 'toggle'; label?: string; checked?: boolean };
  /** Set only for op=navigate: the origin transition this step represents. */
  navigation?: { from_origin: string; to_origin: string };
  summary: string;
  risk: BrowserExtensionAction['risk'];
}

export interface CompileOptions {
  /** Override the derived procedure_id. */
  procedureId?: string;
  /** Natural-language phrases used for intent resolution. At least one required. */
  intentPhrases: string[];
  /** Human-readable service name. Defaults to the recording's tab title. */
  targetName?: string;
  /** Override the risk class derived from the recording. */
  riskClass?: ProcedureRiskClass;
  /**
   * Path prefix for the compiled pipeline file.
   * Default: "pipelines/browser/{procedure_id}.json".
   */
  pipelineRefPrefix?: string;
  /**
   * Repo-relative path to the reviewed recording backing this procedure.
   * Stored on `adapter.recording_ref` so the dispatcher can load it. Required
   * for the procedure to be dispatchable via Pattern B.
   */
  recordingRef?: string;
  /**
   * Initial lifecycle status. Defaults to `'active'` for backward compatibility,
   * but promotion flows should pass `'proposed'`-equivalent handling upstream;
   * a compiled-but-unreviewed entry is a draft until a human approves it.
   */
  status?: ProcedureEntry['status'];
}

export interface CompileRecordingResult {
  procedureEntry: ProcedureEntry;
  goldenScenario: GoldenScenario;
  compiledSteps: CompiledBrowserStep[];
  /** True iff every step has risk "observe" — safe to replay without side-effects. */
  isDryRunSafe: boolean;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Read-only operation set
// ---------------------------------------------------------------------------

/** Operations that produce no external side-effects (read / observe only). */
const READ_ONLY_OPS = new Set<BrowserExtensionOperation>([
  'snapshot',
  'screenshot',
  'extract_text_ref',
  'list_tabs',
  'wait_for_ref',
  'navigate', // origin-transition marker — observe-only segment boundary
]);

/** High-risk operations that mandate `risk_class: 'high'` on the procedure. */
const HIGH_RISK_OPS = new Set<BrowserExtensionOperation>([
  'submit_form',
  'upload_file',
  'download_file',
  'delete',
  'purchase',
  'credential_submit',
  'settings_change',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveRiskClass(recording: BrowserExtensionRecording): ProcedureRiskClass {
  if (recording.risk_summary.approval_required_count > 0) return 'high';
  const hasHighRisk = recording.actions.some(
    (a) => a.risk === 'high' || a.risk === 'sensitive' || HIGH_RISK_OPS.has(a.op)
  );
  if (hasHighRisk) return 'high';
  // Any non-read-only op (click, fill, select, etc.) → medium
  const hasWriteOp = recording.actions.some(
    (a) => a.op !== 'sensitive_input_omitted' && !READ_ONLY_OPS.has(a.op)
  );
  return hasWriteOp ? 'medium' : 'low';
}

/** Derive a stable, filesystem-safe procedure_id from origin + a short recording hash. */
function deriveProcedureId(recording: BrowserExtensionRecording): string {
  // e.g. "https://s2.kingtime.jp" → "s2.kingtime.jp"
  const host = recording.tab.origin.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]/gi, '_');
  const shortHash = createHash('sha256').update(recording.recording_id).digest('hex').slice(0, 8);
  return `browser.${host}.${shortHash}`;
}

/** Extract the last N actions that are good golden-scenario anchors. */
function extractSuccessConditions(actions: BrowserExtensionAction[]): GoldenSuccessCondition[] {
  const conditions: GoldenSuccessCondition[] = [];
  // Walk from the end; collect the first few observation/text signals
  const reversed = [...actions].reverse();
  for (const action of reversed) {
    if (conditions.length >= 3) break;
    if (action.op === 'extract_text_ref' && action.target) {
      conditions.push({
        kind: 'text_present',
        role: action.target.role || undefined,
        name_contains: action.target.name || undefined,
      });
    } else if (action.op === 'wait_for_ref' && action.target) {
      conditions.push({
        kind: 'ref_visible',
        role: action.target.role || undefined,
        name_contains: action.target.name || undefined,
      });
    } else if (action.op === 'snapshot' && action.target) {
      conditions.push({
        kind: 'screenshot_state',
        params: { snapshot_hash: action.target.snapshot_hash },
      });
    }
  }
  if (conditions.length === 0 && actions.length > 0) {
    // Fallback: treat the last action's target as the success anchor
    const last = actions[actions.length - 1];
    if (last.target) {
      conditions.push({
        kind: 'ref_visible',
        role: last.target.role || undefined,
        name_contains: last.target.name || undefined,
      });
    }
  }
  // success_conditions must be non-empty per schema
  if (conditions.length === 0) {
    conditions.push({ kind: 'screenshot_state', params: { anchor: 'recording_end' } });
  }
  return conditions;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns true iff every action in the recording is read-only (risk === "observe").
 * Safe to use as a dry-run gate before offering Pattern B execution.
 */
export function isDryRunSafe(recording: BrowserExtensionRecording): boolean {
  return recording.actions.every((a) => READ_ONLY_OPS.has(a.op));
}

/**
 * Compile a validated `BrowserExtensionRecording` into a draft `ProcedureEntry`
 * and its paired `GoldenScenario`.
 *
 * The procedure starts with `status: 'active'` only after a human review step;
 * callers should store it as a `DistillCandidateRecord` with `status: 'proposed'`
 * and promote it after approval.  The `pipeline_ref` is a placeholder path — the
 * actual pipeline file is written by the distillation step (P3+).
 *
 * Agent-B (Compiler) in the intent-driven automation design.
 * Design: docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md §7 Layer②
 */
export function compileBrowserRecording(
  recording: BrowserExtensionRecording,
  opts: CompileOptions
): CompileRecordingResult {
  if (opts.intentPhrases.length === 0) {
    throw new Error('[browser-recording-compiler] intentPhrases must be non-empty');
  }

  const warnings: string[] = [];
  const procedureId = opts.procedureId ?? deriveProcedureId(recording);
  const riskClass = opts.riskClass ?? deriveRiskClass(recording);
  const targetName = opts.targetName ?? recording.tab.title;
  const dryRunSafe = isDryRunSafe(recording);

  if (!dryRunSafe) {
    warnings.push(
      `Recording contains write/high-risk ops — dry-run replay is NOT safe. ` +
        `${recording.actions.filter((a) => !READ_ONLY_OPS.has(a.op)).length} non-read-only step(s).`
    );
  }
  if (recording.risk_summary.sensitive_input_omitted > 0) {
    warnings.push(
      `${recording.risk_summary.sensitive_input_omitted} sensitive input(s) were omitted from the recording. ` +
        `Mark corresponding required_secrets before activating.`
    );
  }

  // --- Compile steps -------------------------------------------------------
  const actionable = recording.actions.filter((a) => a.op !== 'sensitive_input_omitted');
  const compiledSteps: CompiledBrowserStep[] = actionable.map((action, i) => {
    const step: CompiledBrowserStep = {
      step_index: i,
      op: action.op,
      summary: action.summary,
      risk: action.risk,
    };
    if (action.target) {
      step.ref = action.target.ref;
      step.role = action.target.role;
      step.name = action.target.name;
      step.snapshot_hash = action.target.snapshot_hash;
      if (action.target.dom_path) step.dom_path = action.target.dom_path;
    }
    if (action.variable) step.variable = action.variable;
    if (action.selection) step.selection = action.selection;
    if (action.navigation) step.navigation = action.navigation;
    return step;
  });

  // Collect every origin this recording touches: the initial tab origin plus
  // each navigate handoff's destination. A multi-origin (segmented) recording
  // surfaces all of them so review/approval and execution see the full set.
  const origins = Array.from(
    new Set<string>([
      recording.tab.origin,
      ...recording.actions
        .filter((a) => a.op === 'navigate' && a.navigation)
        .map((a) => a.navigation!.to_origin),
    ])
  );

  // --- ProcedureEntry (draft) -----------------------------------------------
  const pipelineRef = opts.pipelineRefPrefix
    ? `${opts.pipelineRefPrefix.replace(/\/$/, '')}/${procedureId}.json`
    : `pipelines/browser/${procedureId}.json`;

  const procedureEntry: ProcedureEntry = {
    procedure_id: procedureId,
    substrate: 'browser',
    adapter: {
      recorder: 'chrome-extension',
      executor: 'extension_session',
      ...(opts.recordingRef ? { recording_ref: opts.recordingRef } : {}),
    },
    target: {
      name: targetName,
      origins,
    },
    intent_phrases: opts.intentPhrases,
    execution_substrate: 'extension',
    pipeline_ref: pipelineRef,
    risk_class: riskClass,
    version: '1.0.0',
    status: opts.status ?? 'active',
  };

  // --- GoldenScenario -------------------------------------------------------
  const scenarioId = `gs-${procedureId}`;
  const successConditions = extractSuccessConditions(actionable);

  const goldenScenario: GoldenScenario = {
    schema_version: 'golden-scenario.v1',
    scenario_id: scenarioId,
    procedure_id: procedureId,
    success_conditions: successConditions,
    captured_from: recording.recording_id,
    version: '1.0.0',
  };

  return { procedureEntry, goldenScenario, compiledSteps, isDryRunSafe: dryRunSafe, warnings };
}
