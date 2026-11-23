/**
 * Export a browser-control session journal as `browser-recording.v1` so an
 * interactive `browser control` session can enter the existing
 * review → promote-procedure → Pattern B chain.
 *
 * The journal's `step.enqueued` entries carry the full admitted step payload
 * (minus `file.data_b64`, which is replaced by metadata at journal time), so
 * the export is deterministic and does not depend on mailbox record
 * retention.
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
} from '@agent/core/secure-io';
import { readJsonIfPresent, writeJson } from '@agent/core/foundation/json';
import { streamJsonLines } from '@agent/core/jsonl-read';
import { runtimeStatePath } from '@agent/core/foundation/runtime-state-roots';
import {
  canonicalOrigin,
  computeRecordingRiskSummary,
  HIGH_RISK_OPERATIONS,
  validateBrowserExtensionRecording,
  type BrowserExtensionAction,
  type BrowserExtensionRecording,
} from '@agent/core/browser/browser-extension-bridge';
import {
  BROWSER_CONTROL_SESSION_ROOT,
  loadBrowserControlSession,
  type BrowserControlSession,
} from './browser-control-sessions.js';
import type { BrowserBridgeControlStep } from './browser-bridge-mailbox.js';

/** Repo-relative recordings store — the allowlisted root promote-procedure accepts. */
const RECORDINGS_STORE_REL = runtimeStatePath('browser.recordingsStore').physicalPath;

/**
 * Ops that produce no replayable action — observation or bridge-level tab ops.
 * `open_tab` is session establishment in interactive control: the action schema
 * has no `url` field (replay opens `recording.tab.origin` itself), so an
 * exported open_tab action could never satisfy the `browser:open_tab` contract.
 */
const NON_REPLAY_OPS = new Set<string>([
  'snapshot',
  'screenshot',
  'extract_text_ref',
  'list_tabs',
  'select_tab',
  'open_tab',
]);

/**
 * `press_ref` replays with the extension's default key (Enter); the recording
 * action schema has no `key` field, so a non-default key would silently
 * downgrade to Enter at replay — skip those steps instead of miscompiling.
 */
function isReplayable(step: BrowserBridgeControlStep): boolean {
  if (NON_REPLAY_OPS.has(step.op)) return false;
  if (step.op === 'press_ref' && step.key !== undefined && step.key !== 'Enter') return false;
  return true;
}

const OBSERVE_RISK_OPS = new Set<string>(['wait_for_ref', 'navigate']);

interface JournalEntry {
  ts?: string;
  event?: string;
  step_id?: string;
  request_id?: string;
  step?: BrowserBridgeControlStep & { file?: { name?: string; mime?: string; bytes?: number } };
}

export interface ControlRecordingExport {
  status: 'exported';
  recording_id: string;
  recording_ref: string;
  action_count: number;
  /** Non-replayable or non-default-key steps intentionally left out. */
  skipped_steps: number;
  /** Enqueued steps with no successful outcome — never demonstrated. */
  dropped_unexecuted: number;
  session: Pick<BrowserControlSession, 'session_id' | 'origin' | 'status'>;
}

export type ControlRecordingExportResult =
  ControlRecordingExport | { status: 'error'; reason: string };

function journalPath(sessionId: string): string {
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(
      path.posix.join(BROWSER_CONTROL_SESSION_ROOT, `${sessionId}.journal.jsonl`)
    ),
    { rootDir: pathResolver.rootDir(), allowMissingLeaf: true }
  );
}

function readJournalEntries(sessionId: string): JournalEntry[] {
  const file = journalPath(sessionId);
  if (!safeExistsSync(file)) return [];
  // 'skip' tolerates a torn tail line rather than failing the export.
  return [...streamJsonLines<JournalEntry>(file, { onMalformed: 'skip' })];
}

function syntheticSnapshotHash(step: BrowserBridgeControlStep): string {
  return createHash('sha256')
    .update(`control-export:${step.ref ?? ''}|${step.role ?? ''}|${step.name ?? ''}`)
    .digest('hex');
}

function variableName(step: BrowserBridgeControlStep, index: number): string {
  const source = step.name || step.ref?.replace(/^@/, '') || `field_${index + 1}`;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 63);
  return /^[a-z]/.test(slug) ? slug : `field_${index + 1}`;
}

function summarize(step: BrowserBridgeControlStep): string {
  const target = step.name || step.role || step.ref || step.url || '';
  const base = step.label || `${step.op}${target ? ` ${target}` : ''}`;
  return base.slice(0, 500);
}

function toAction(
  step: BrowserBridgeControlStep,
  index: number,
  capturedAt: string,
  prevOrigin: string
): { action: BrowserExtensionAction | null; nextOrigin: string } {
  if (!isReplayable(step)) return { action: null, nextOrigin: prevOrigin };

  const action: BrowserExtensionAction = {
    action_id: `act-${String(index + 1).padStart(3, '0')}`,
    op: step.op,
    summary: summarize(step),
    risk: HIGH_RISK_OPERATIONS.has(step.op)
      ? 'high'
      : OBSERVE_RISK_OPS.has(step.op)
        ? 'observe'
        : 'low',
    captured_at: capturedAt,
  };

  if (step.op === 'navigate') {
    const toOrigin = step.url ? canonicalOrigin(step.url) : null;
    if (!toOrigin) return { action: null, nextOrigin: prevOrigin };
    action.navigation = { from_origin: prevOrigin, to_origin: toOrigin };
    return { action, nextOrigin: toOrigin };
  }

  if (step.ref) {
    action.target = {
      ref: step.ref,
      role: step.role ?? '',
      name: step.name ?? '',
      snapshot_hash: syntheticSnapshotHash(step),
    };
  }
  if (step.op === 'fill_ref') {
    action.variable = { name: variableName(step, index), classification: 'user_input' };
  }
  if (step.op === 'select_ref') {
    action.selection = {
      kind: 'option',
      ...(step.text || step.value ? { label: String(step.text ?? step.value).slice(0, 500) } : {}),
      ...(step.checked !== undefined ? { checked: step.checked } : {}),
    };
  }
  return { action, nextOrigin: prevOrigin };
}

/**
 * Compile a session journal into a schema-validated `browser-recording.v1`
 * persisted under `active/shared/runtime/recordings/` with
 * `review.status = 'pending'` — the same store `save_recording` uses, so the
 * existing review and promote-procedure flow applies unchanged.
 */
export function exportBrowserControlRecording(input: {
  session_id: string;
  title?: string;
}): ControlRecordingExportResult {
  // Malformed ids throw inside the session path guard — surface them as the
  // same clean error as an unknown-but-well-formed id.
  let session: BrowserControlSession | null = null;
  try {
    session = loadBrowserControlSession(input.session_id);
  } catch {
    session = null;
  }
  if (!session) return { status: 'error', reason: `unknown session ${input.session_id}` };

  const entries = readJournalEntries(input.session_id);
  // Only steps the extension actually reported `completed` are demonstrated
  // behavior — failed/declined/expired or still-pending steps are dropped so
  // the recording replays what provably worked.
  const completed = new Set(
    entries
      .filter((entry) => entry.event === 'step.completed' && entry.request_id)
      .map((entry) => entry.request_id as string)
  );
  let droppedUnexecuted = 0;
  const steps: { step: BrowserBridgeControlStep; ts?: string }[] = [];
  for (const entry of entries) {
    if (entry.event !== 'step.enqueued' || !entry.step) continue;
    if (!entry.request_id || !completed.has(entry.request_id)) {
      droppedUnexecuted += 1;
      continue;
    }
    steps.push({ step: entry.step, ts: entry.ts });
  }
  if (steps.length === 0) {
    return {
      status: 'error',
      reason:
        droppedUnexecuted > 0
          ? `session ${input.session_id} has no completed steps to export (${droppedUnexecuted} enqueued step(s) had no successful outcome)`
          : `session ${input.session_id} has no enqueued steps to export`,
    };
  }

  let origin = session.origin;
  const actions: BrowserExtensionAction[] = [];
  let skipped = 0;
  for (const { step, ts } of steps) {
    const { action, nextOrigin } = toAction(step, actions.length, ts ?? session.created_at, origin);
    origin = nextOrigin;
    if (action) actions.push(action);
    else skipped += 1;
  }
  if (actions.length === 0) {
    return {
      status: 'error',
      reason: `session ${input.session_id} produced no replayable actions (observe-only session)`,
    };
  }

  const recording: BrowserExtensionRecording = {
    schema_version: 'browser-recording.v1',
    recording_id: `BCR-${randomUUID()}`,
    source: 'chrome-extension',
    created_at: new Date().toISOString(),
    tab: {
      origin: session.origin,
      origin_hash: createHash('sha256').update(session.origin).digest('hex'),
      title: (input.title ?? session.label ?? session.origin).slice(0, 500),
    },
    extension: { version: 'control-export' },
    actions,
    risk_summary: computeRecordingRiskSummary(actions),
    review: {
      status: 'pending',
      decisions: actions.map((action) => ({ action_id: action.action_id, status: 'pending' })),
    },
  };

  const validation = validateBrowserExtensionRecording(recording);
  if (!validation.valid) {
    return {
      status: 'error',
      reason: `exported recording failed validation: ${validation.errors.join('; ')}`,
    };
  }

  const rel = `${RECORDINGS_STORE_REL}/${recording.recording_id}.json`;
  const abs = assertSafeRepositoryPath(pathResolver.rootResolve(rel), {
    rootDir: pathResolver.rootDir(),
    allowMissingLeaf: true,
  });
  safeMkdir(path.dirname(abs));
  writeJson(abs, recording);

  return {
    status: 'exported',
    recording_id: recording.recording_id,
    recording_ref: rel,
    action_count: actions.length,
    skipped_steps: skipped,
    dropped_unexecuted: droppedUnexecuted,
    session: {
      session_id: session.session_id,
      origin: session.origin,
      status: session.status,
    },
  };
}

// ---------------------------------------------------------------------------
// Recordings store — list / load / review helpers shared by the CLI verbs.
// ---------------------------------------------------------------------------

const RECORDING_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function recordingPath(recordingId: string): string {
  if (!RECORDING_ID_PATTERN.test(recordingId)) {
    throw new Error('[BROWSER_RECORDING_INVALID] malformed recording_id');
  }
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(path.posix.join(RECORDINGS_STORE_REL, `${recordingId}.json`)),
    { rootDir: pathResolver.rootDir(), allowMissingLeaf: true }
  );
}

export function loadExportedRecording(recordingId: string): BrowserExtensionRecording | null {
  try {
    const parsed = readJsonIfPresent<BrowserExtensionRecording>(recordingPath(recordingId));
    return parsed?.schema_version === 'browser-recording.v1' ? parsed : null;
  } catch {
    return null;
  }
}

export interface RecordingSummary {
  recording_id: string;
  origin: string;
  title: string;
  action_count: number;
  high_risk_count: number;
  review_status: string;
  created_at: string;
}

export function listExportedRecordings(): RecordingSummary[] {
  const dir = pathResolver.rootResolve(RECORDINGS_STORE_REL);
  if (!safeExistsSync(dir)) return [];
  const out: RecordingSummary[] = [];
  for (const name of safeReaddir(dir)) {
    if (!name.endsWith('.json')) continue;
    let recording: BrowserExtensionRecording | null = null;
    try {
      recording = loadExportedRecording(name.replace(/\.json$/, ''));
    } catch {
      continue; // stray or malformed entry — not a recording
    }
    if (!recording) continue;
    out.push({
      recording_id: recording.recording_id,
      origin: recording.tab.origin,
      title: recording.tab.title,
      action_count: recording.actions.length,
      high_risk_count: recording.risk_summary.approval_required_count,
      review_status: recording.review?.status ?? 'none',
      created_at: recording.created_at,
    });
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/**
 * Apply review decisions to an exported recording. Approving is a human
 * judgment — the CLI surface only writes what the operator decided; the
 * promote path still enforces the full contract (no pending decisions, at
 * least one approved action).
 */
export function reviewExportedRecording(input: {
  recording_id: string;
  approve?: string[];
  reject?: string[];
  approve_all?: boolean;
}): { status: 'reviewed'; review_status: string } | { status: 'error'; reason: string } {
  const recording = loadExportedRecording(input.recording_id);
  if (!recording) {
    return { status: 'error', reason: `unknown recording ${input.recording_id}` };
  }
  const actionIds = new Set(recording.actions.map((action) => action.action_id));
  for (const id of [...(input.approve ?? []), ...(input.reject ?? [])]) {
    if (!actionIds.has(id)) {
      return { status: 'error', reason: `unknown action_id ${id} (see \`recordings show\`)` };
    }
  }

  const prior = new Map(
    (recording.review?.decisions ?? []).map((decision) => [decision.action_id, decision.status])
  );
  const decisions = recording.actions.map((action) => {
    if (input.approve_all === true || input.approve?.includes(action.action_id)) {
      return { action_id: action.action_id, status: 'approved' as const };
    }
    if (input.reject?.includes(action.action_id)) {
      return { action_id: action.action_id, status: 'rejected' as const };
    }
    return {
      action_id: action.action_id,
      status: prior.get(action.action_id) ?? ('pending' as const),
    };
  });
  const pending = decisions.filter((decision) => decision.status === 'pending').length;
  const approved = decisions.filter((decision) => decision.status === 'approved').length;
  const status = pending > 0 ? 'in_review' : approved > 0 ? 'approved' : 'rejected';

  recording.review = {
    status,
    reviewed_at: new Date().toISOString(),
    decisions,
  };
  const validation = validateBrowserExtensionRecording(recording);
  if (!validation.valid) {
    return {
      status: 'error',
      reason: `review would leave the recording invalid: ${validation.errors.join('; ')}`,
    };
  }
  writeJson(recordingPath(input.recording_id), recording);
  return { status: 'reviewed', review_status: status };
}
