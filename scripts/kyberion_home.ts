#!/usr/bin/env node
/**
 * `pnpm kyberion` — the operator's single entry point (E2E-04 / SU-01 minimal).
 *
 * Design rule: every command this screen advertises MUST actually work from
 * here. The home view answers "do I need to do anything?" and each queue
 * (inbox / approvals) is actionable in place; `ask` talks to the same brain
 * every other surface uses.
 */
import { resolveOperatorDisplayName } from '@agent/core/operator-identity';
import {
  getRegisteredEnvText,
  nowIso,
  parseSafeJsonObjectInput,
  setRegisteredEnv,
} from '@agent/core/foundation';
import {
  acceptInboxEntryWithHumanReceipt,
  listInboxEntries,
  markInboxEntry,
} from '@agent/core/deliverable-inbox';
import { createScreenRecordingBridge } from '@agent/core/screen-recording-bridge';
import { createDesktopEventFeed } from '@agent/core/desktop-event-feed';
import {
  computeDesktopRecordingHash,
  DesktopDemonstrationRecorder,
  sanitizeDesktopObservationText,
  sampleDesktopObservation,
  validateDesktopRecording,
} from '@agent/core/desktop-recording';
import { dispatchProcedure } from '@agent/core/procedure-dispatcher';
import { decideApprovalRequest, listApprovalRequests } from '@agent/core/approval-store';
import { loadDesktopPipeline } from '@agent/core/desktop-pipeline';
import {
  loadProcedures,
  resolveAllowlistedRecordingRef,
  resolveProcedure,
} from '@agent/core/procedure-registry';
import {
  loadNotificationPreferences,
  saveNotificationPreferences,
} from '@agent/core/operator-notifications';
import { materializeExecutionFeedbackCandidate } from '@agent/core/execution-feedback';
import { promoteDesktopProcedure } from '@agent/core/desktop-recording-compiler';
import { reconcileDesktopPromotionTransaction } from '@agent/core/desktop-promotion-transaction';
import {
  intentDraftHash,
  loadDesktopIntentDraftAtPath,
  reconstructDesktopIntent,
  reviewDesktopIntent,
} from '@agent/core/desktop-intent-reconstruction';
import { redactScreenVideoFrame } from '@agent/core/screen-frame-redaction';
import { loadBrowserExtensionRecordingAtPath } from '@agent/core/browser-extension-bridge';
import { loadServiceRecordingAtPath } from '@agent/core/service-recording';
import { loadDesktopRecordingAtPath } from '@agent/core/desktop-recording';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { runSurfaceMessageConversation } from '@agent/core/surface-runtime-orchestrator';
import {
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import { osAutomationBridge } from '@agent/core/os-automation-bridge';
import type {
  BrowserExtensionOperation,
  BrowserExtensionRecording,
} from '@agent/core/browser-extension-bridge';
import type { DesktopRecording } from '@agent/core/desktop-recording';
import type { ServiceRecording } from '@agent/core/service-recording';
import type { NotificationChannelTarget } from '@agent/core/operator-notifications';
import { createStandardYargs } from '@agent/core/cli-utils';
import { runDoctor } from './run_doctor.js';
import {
  handleDealsIngestAudio,
  handleDealsSubcommand,
  handleFeedbackSubcommand,
  handleImprovements,
} from './operator-home-secondary-actions.js';
import { printCommands, showHome, type HomePrint } from './operator-home-view.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import path from 'node:path';
import {
  createExecuteBrowserPipeline,
  loadBrowserActuator,
} from './browser_playwright_executor.js';
import { createHash, randomUUID } from 'node:crypto';
import { t as translate } from '@agent/core/t';
import { resolveLocale, type SupportedLocale } from '@agent/core/locale';
import type { VocabularyKey } from '@agent/core/t';
import {
  renderIntentAuthorityLabel,
  renderIntentOutcomeLabel,
} from '@agent/core/intent-resolution-contract';

let activePrint: HomePrint = () => undefined;

function printOutput(value: unknown): void {
  activePrint(value);
}

let cliLocale: SupportedLocale = resolveLocale();

function ui(key: VocabularyKey, params?: Record<string, string | number>): string {
  return translate(key, params, cliLocale);
}

function localizeRecorderError(error: string): string {
  if (error.includes('intent review') || error.includes('desktop intent'))
    return ui('recorder:recorder_intent_review_required');
  if (error.includes('recording review must be approved'))
    return ui('recorder:recorder_review_repair');
  const native = error.match(/native operation ([a-z0-9_:-]+)/iu);
  if (native) return ui('recorder:recorder_native_executor_required', { op: native[1] });
  const nativeBinding = error.match(/native execution bindings \(([^,)]+)/iu);
  if (nativeBinding)
    return ui('recorder:recorder_native_executor_required', { op: nativeBinding[1] });
  if (error.includes('invalid coordinates or click_count') || error.includes('invalid selector'))
    return ui('recorder:recorder_desktop_input_invalid');
  if (error.includes('screen frame withheld') || error.includes('redaction'))
    return ui('recorder:recorder_screenshot_redaction_failed');
  return error;
}

function localizeRecorderWarning(warning: string): string {
  if (warning.startsWith('native operation suggestions remain'))
    return ui('recorder:recorder_native_plan_deferred');
  return warning;
}

// E2E-04 Task 2: `pnpm kyberion notify --set slack:C012345` writes the
// operator's default notification channel (surface:target).
function handleNotifySubcommand(setValue: string): void {
  const [surface, ...rest] = setValue.split(':');
  const target = rest.join(':');
  const allowed = ['slack', 'imessage', 'telegram', 'discord'];
  if (!allowed.includes(surface) || !target) {
    printOutput(ui('recorder:recorder_notify_usage', { channels: allowed.join('|') }));
    throw new ScriptExitError(1, '', true);
  }
  const prefs = loadNotificationPreferences();
  prefs.default_channel = { surface, target } as NotificationChannelTarget;
  const filePath = saveNotificationPreferences(prefs);
  printOutput(ui('recorder:recorder_notify_saved', { surface, target, path: filePath }));
}

function handleInboxSubcommand(argv: {
  read?: string;
  accept?: string;
  readAll?: boolean;
  match?: string;
  json?: boolean;
}): void {
  if (argv.readAll) {
    const entries = listInboxEntries({ limit: 500 }).filter(
      (entry) =>
        entry.status === 'unread' &&
        (!argv.match || entry.title.includes(argv.match) || entry.summary.includes(argv.match))
    );
    for (const entry of entries) {
      markInboxEntry(entry.entry_id, 'read', { reviewedBy: 'operator' });
    }
    printOutput(
      ui('recorder:recorder_inbox_marked', {
        count: entries.length,
        match: argv.match ? ` (match: ${argv.match})` : '',
      })
    );
    return;
  }
  if (argv.read || argv.accept) {
    const entryId = String(argv.read || argv.accept);
    const updated = argv.read
      ? markInboxEntry(entryId, 'read', { reviewedBy: 'operator' })
      : acceptInboxEntryWithHumanReceipt({
          entryId,
          actorId: 'human:operator',
          authenticated: true,
          authMethod: 'surface_session',
          responsibilityStatement:
            'I accept this deliverable and retain responsibility for its use.',
        });
    if (!updated) {
      printOutput(ui('recorder:recorder_inbox_not_found', { id: entryId }));
      throw new ScriptExitError(1, '', true);
    }
    printOutput(
      ui('recorder:recorder_inbox_updated', {
        id: updated.entry_id,
        status: updated.status,
        title: updated.title,
      })
    );
    return;
  }
  const entries = listInboxEntries({ limit: 30 });
  if (argv.json) {
    printOutput(JSON.stringify(entries, null, 2));
    return;
  }
  if (entries.length === 0) {
    printOutput(ui('recorder:recorder_inbox_empty'));
    return;
  }
  const unread = entries.filter((entry) => entry.status === 'unread');
  printOutput(
    ui('recorder:recorder_inbox_header', { unread: unread.length, total: entries.length })
  );
  for (const entry of entries) {
    const marker = entry.status === 'unread' ? '●' : entry.status === 'accepted' ? '✔' : '○';
    printOutput(`  ${marker} [${entry.entry_id}] ${entry.title}`);
    printOutput(`      ${entry.summary.slice(0, 100)}`);
    if (entry.artifact_paths.length > 0) {
      printOutput(
        `      → ${entry.artifact_paths[0]}${entry.artifact_paths.length > 1 ? ` (+${entry.artifact_paths.length - 1})` : ''}`
      );
    }
  }
  printOutput('');
  printOutput(ui('recorder:recorder_inbox_summary'));
}

function handleApprovalsSubcommand(argv: {
  approve?: string;
  deny?: string;
  note?: string;
  json?: boolean;
}): void {
  const pending = listApprovalRequests({ status: 'pending' });
  if (argv.approve || argv.deny) {
    const requestId = String(argv.approve || argv.deny);
    const request = pending.find((entry) => entry.id === requestId);
    if (!request) {
      printOutput(ui('recorder:recorder_approvals_not_found', { id: requestId }));
      throw new ScriptExitError(1, '', true);
    }
    const decided = decideApprovalRequest('mission_controller', {
      channel: request.channel,
      storageChannel: request.storageChannel,
      requestId: request.id,
      decision: argv.approve ? 'approved' : 'rejected',
      decidedBy: resolveOperatorDisplayName(),
      decidedByRole: 'sovereign',
      authMethod: 'manual',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: request.accountability?.payloadHash,
      effectBinding: request.accountability?.effectBinding,
      note: argv.note || 'decided via pnpm kyberion approvals',
    });
    printOutput(
      ui('recorder:recorder_approval_updated', {
        id: decided.id,
        status: decided.status,
        title: decided.title,
      })
    );
    return;
  }
  if (argv.json) {
    printOutput(JSON.stringify(pending, null, 2));
    return;
  }
  if (pending.length === 0) {
    printOutput(ui('recorder:recorder_approvals_empty'));
    return;
  }
  printOutput(ui('recorder:recorder_approvals_header', { count: pending.length }));
  for (const request of pending) {
    printOutput(`  ● [${request.id}] ${request.title}`);
    if (request.summary) printOutput(`      ${String(request.summary).slice(0, 120)}`);
    printOutput(
      `      requested by ${request.requestedBy} via ${request.channel} at ${request.requestedAt}`
    );
  }
  printOutput('');
  printOutput(ui('recorder:recorder_approvals_summary'));
}

async function handleAskSubcommand(
  text: string,
  json: boolean,
  explain: boolean,
  clarify: boolean
): Promise<void> {
  if (!text.trim()) {
    printOutput(ui('recorder:recorder_ask_usage'));
    throw new ScriptExitError(1, '', true);
  }
  const correlationId = `kyberion-ask-${Date.now().toString(36)}`;
  const result = await runSurfaceMessageConversation({
    surface: 'cli',
    text,
    channel: 'kyberion-home',
    threadTs: correlationId,
    correlationId,
    receivedAt: nowIso(),
    locale: cliLocale,
    actorId: 'operator',
    senderAgentId: 'kyberion:home-cli',
    agentId: 'cli-surface-agent',
    delegationSummaryInstruction:
      'Produce a concise terminal-friendly reply in the operator language. No A2A blocks.',
  });
  const intentResolution = result.intentResolution;
  const improvement = result.executionFeedbackRecord
    ? materializeExecutionFeedbackCandidate({ feedback: result.executionFeedbackRecord })
    : null;
  if (json) {
    printOutput(JSON.stringify({ ...result, intentResolution, improvement }, null, 2));
    return;
  }
  if ((explain || clarify) && intentResolution) {
    printOutput(`[intent] ${intentResolution.normalized_intent}`);
    printOutput(`  request_id: ${intentResolution.request_id}`);
    printOutput(`  shape: ${intentResolution.resolution_shape}`);
    printOutput(`  outcome: ${renderIntentOutcomeLabel(intentResolution.outcome_kind, cliLocale)}`);
    printOutput(
      `  authority: ${renderIntentAuthorityLabel(intentResolution.authority_level, cliLocale)}`
    );
    printOutput(`  missing_inputs: ${intentResolution.missing_inputs.join(', ') || '(none)'}`);
    printOutput(`  next_action: ${intentResolution.next_action.kind}`);
    printOutput(`  next_action_label: ${intentResolution.next_action.label}`);
    printOutput(`  consequence: ${intentResolution.next_action.consequence}`);
    printOutput('');
  }
  if (intentResolution && intentResolution.normalized_intent !== 'unresolved_intent') {
    printOutput(
      `[intent] ${intentResolution.normalized_intent} ` +
        `(shape=${intentResolution.resolution_shape}, authority=${renderIntentAuthorityLabel(intentResolution.authority_level, cliLocale)})`
    );
  } else if (intentResolution?.authority_level === 'human_clarification_required') {
    printOutput(ui('recorder:recorder_intent_ambiguous'));
  }
  const reply = (result as { text?: string })?.text;
  printOutput(reply?.trim() || ui('recorder:recorder_ask_empty'));
  if (improvement?.candidate) {
    printOutput(
      ui('recorder:recorder_improvement_created', { id: improvement.candidate.candidate_id })
    );
  }
}

function procedureEntryOrReport(procedureId: string) {
  const entry = loadProcedures().find((candidate) => candidate.procedure_id === procedureId);
  if (!entry) {
    printOutput(ui('recorder:recorder_procedure_not_found', { id: procedureId }));
    throw new ScriptExitError(1, '', true);
    return null;
  }
  return entry;
}

function printProcedureEntry(entry: ReturnType<typeof loadProcedures>[number]): void {
  printOutput(
    ui('recorder:recorder_procedure_entry', {
      id: entry.procedure_id,
      substrate: entry.substrate,
      executor: entry.adapter.executor,
      risk: entry.risk_class,
      status: entry.status,
    })
  );
  printOutput(ui('recorder:recorder_procedure_target', { target: entry.target.name }));
  if (entry.intent_phrases.length > 0) {
    printOutput(
      ui('recorder:recorder_procedure_intent', { intent: entry.intent_phrases.join(' / ') })
    );
  }
}

function handleProcedureList(argv: { substrate?: string; json?: boolean }): void {
  const procedures = loadProcedures().filter(
    (entry) => !argv.substrate || entry.substrate === argv.substrate
  );
  if (argv.json) {
    printOutput(JSON.stringify(procedures, null, 2));
    return;
  }
  if (procedures.length === 0) {
    printOutput(ui('recorder:recorder_no_procedures'));
    return;
  }
  printOutput(ui('recorder:recorder_procedure_count', { count: procedures.length }));
  for (const entry of procedures) printProcedureEntry(entry);
}

async function handleIntentSubcommand(
  text: string,
  argv: { substrate?: string; origin?: string; json?: boolean }
): Promise<void> {
  if (!text.trim()) {
    printOutput(ui('recorder:recorder_intent_usage'));
    throw new ScriptExitError(1, '', true);
  }
  const resolution = await withExecutionContext(
    'sovereign_concierge',
    () => resolveProcedure(text, { substrate: argv.substrate, origin: argv.origin }),
    'sovereign'
  );
  const procedure = resolution.best
    ? loadProcedures().find((entry) => entry.procedure_id === resolution.best?.procedure_id)
    : undefined;
  const payload = {
    intent: text,
    resolution,
    procedure: procedure
      ? {
          procedure_id: procedure.procedure_id,
          substrate: procedure.substrate,
          executor: procedure.adapter.executor,
          target: procedure.target,
          risk_class: procedure.risk_class,
          required_inputs: procedure.required_inputs || [],
          required_secrets: (procedure.required_secrets || []).map((secret) => ({
            name: secret.name,
            scope: secret.scope,
          })),
          review_required: procedure.risk_class !== 'low',
        }
      : null,
    next_actions: procedure
      ? [
          `pnpm kyberion procedure inspect ${procedure.procedure_id}`,
          `pnpm kyberion procedure run ${procedure.procedure_id} --inputs '{}'`,
        ]
      : [ui('recorder:recorder_procedure_learn_next')],
  };
  if (argv.json) {
    printOutput(JSON.stringify(payload, null, 2));
    return;
  }
  printOutput(ui('recorder:recorder_intent_label', { text }));
  printOutput(
    ui('recorder:recorder_resolution', {
      outcome: resolution.outcome,
      pattern: resolution.recommendedPattern,
    })
  );
  if (procedure) {
    printProcedureEntry(procedure);
    printOutput(`  ${ui('recorder:recorder_next_inspect', { id: procedure.procedure_id })}`);
    printOutput(`           pnpm kyberion procedure run ${procedure.procedure_id} --inputs '{}'`);
  } else if (resolution.candidates.length > 0) {
    printOutput(ui('recorder:recorder_intent_candidates'));
    for (const candidate of resolution.candidates) {
      printOutput(
        `  - ${candidate.procedure_id} (${candidate.confidence.toFixed(2)}) ${candidate.reason}`
      );
    }
    printOutput(ui('recorder:recorder_candidates_next'));
  } else {
    printOutput(ui('recorder:recorder_unmatched'));
  }
}

function loadProcedureRecording(entry: ReturnType<typeof loadProcedures>[number]): {
  value?: BrowserExtensionRecording | DesktopRecording | ServiceRecording;
  error?: string;
} {
  const recordingPath = resolveAllowlistedRecordingRef(entry.adapter.recording_ref);
  if (!recordingPath) {
    return { error: ui('recorder:recorder_recording_ref_invalid') };
  }
  if (!safeExistsSync(recordingPath) || !safeLstat(recordingPath).isFile()) {
    return {
      error: ui('recorder:recorder_recording_read_failed', {
        error: 'recording is not a regular file',
      }),
    };
  }
  if (entry.substrate === 'service') {
    try {
      return { value: loadServiceRecordingAtPath(recordingPath) };
    } catch (error) {
      return {
        error: ui('recorder:recorder_recording_read_failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }
  if (entry.substrate === 'desktop') {
    try {
      return { value: loadDesktopRecordingAtPath(recordingPath) };
    } catch (error) {
      return {
        error: ui('recorder:recorder_recording_read_failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }
  if (entry.substrate === 'browser') {
    try {
      return { value: loadBrowserExtensionRecordingAtPath(recordingPath) };
    } catch (error) {
      return {
        error: ui('recorder:recorder_recording_read_failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      };
    }
  }
  return { error: ui('recorder:recorder_unsupported_substrate') };
}

function resolveRecordingPath(ref: string): string | null {
  return resolveAllowlistedRecordingRef(ref.trim());
}

async function handleDesktopRecord(argv: {
  duration?: number;
  fps?: number;
  displayIndex?: number;
  captureMode?: string;
  json?: boolean;
}): Promise<void> {
  const duration = Math.min(300, Math.max(1, Math.round(Number(argv.duration || 15))));
  const fps = Math.min(30, Math.max(1, Math.round(Number(argv.fps || 1))));
  const runId = `cli-${Date.now()}`;
  const recordingDir = pathResolver.shared('runtime/recordings');
  const videoAbs = pathResolver.shared(`runtime/recordings/desktop-screen-${runId}.mp4`);
  safeMkdir(recordingDir, { recursive: true });
  const eventFeed = createDesktopEventFeed();
  eventFeed.start();
  let pollError: string | undefined;

  const recorder = new DesktopDemonstrationRecorder({
    sample: () => sampleDesktopObservation(osAutomationBridge),
    eventSource: () => eventFeed.drain(),
    baseIntervalMs: 1_000,
    browserIntervalMs: 1_500,
    heartbeatMs: 5_000,
  });
  recorder.start();
  const timer = setInterval(() => {
    try {
      recorder.pollOnce(Date.now());
    } catch (error) {
      pollError = error instanceof Error ? error.message : String(error);
    }
  }, 1_000);
  let screenRecording:
    | { status: 'succeeded'; output_path: string; frame_count: number; fps: number }
    | { status: 'unavailable'; reason: string };
  try {
    const bridge = createScreenRecordingBridge({ frame_redactor: redactScreenVideoFrame });
    const probe = await bridge.probe();
    if (!probe.available) {
      screenRecording = {
        status: 'unavailable',
        reason: probe.capture_bridge?.reason || 'screen recording bridge unavailable',
      };
    } else {
      const result = await bridge.recordToMp4(videoAbs, {
        display_index: argv.displayIndex,
        capture_mode: argv.captureMode === 'focused_window' ? 'focused_window' : 'screen',
        max_frames: duration * fps,
        frame_interval_ms: Math.round(1_000 / fps),
        fps,
        cleanup: true,
      });
      screenRecording = { status: 'succeeded', ...result };
    }
  } catch (error) {
    screenRecording = {
      status: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearInterval(timer);
    // Drain events that arrived during the final screen frame before stopping
    // the native tap. Otherwise the tail of a demonstration is silently
    // omitted from the promotion candidate.
    recorder.pollOnce(Date.now());
    eventFeed.stop();
  }

  let recording = recorder.stop();
  const feedStatus = eventFeed.status();
  const capture = pollError
    ? {
        event_source: 'state-observation-only' as const,
        status: 'unavailable' as const,
        reason:
          sanitizeDesktopObservationText(`OS observation failed: ${pollError}`) ||
          'OS observation failed',
      }
    : feedStatus.status === 'active'
      ? feedStatus
      : {
          event_source: 'state-observation-only' as const,
          status: 'unavailable' as const,
          reason:
            sanitizeDesktopObservationText(
              feedStatus.reason || 'OS event feed became unavailable during capture'
            ) || 'OS event feed became unavailable during capture',
        };
  const screenArtifact =
    screenRecording.status === 'succeeded' && safeExistsSync(screenRecording.output_path)
      ? (() => {
          const payload = safeReadFile(screenRecording.output_path, { encoding: null }) as Buffer;
          return {
            status: 'succeeded' as const,
            recording_ref: pathResolver.toRepoRelative(screenRecording.output_path),
            sha256: createHash('sha256').update(payload).digest('hex'),
            frame_count: screenRecording.frame_count,
            fps: screenRecording.fps,
          };
        })()
      : {
          status: 'unavailable' as const,
          reason:
            sanitizeDesktopObservationText(
              screenRecording.status === 'unavailable'
                ? screenRecording.reason
                : 'screen recording output was not created'
            ) || 'screen recording output was not created',
        };
  recording = {
    ...recording,
    capture,
    artifacts: { screen_recording: screenArtifact },
  };
  const intent = reconstructDesktopIntent(recording);
  recording = {
    ...recording,
    intent_hash: intentDraftHash(intent),
  };
  recording.recording_hash = computeDesktopRecordingHash(recording);
  const recordingValidation = validateDesktopRecording(recording);
  if (!recordingValidation.value) {
    throw new Error(`recording failed validation: ${recordingValidation.errors.join('; ')}`);
  }
  const recordingAbs = pathResolver.shared(`runtime/recordings/${recording.recording_id}.json`);
  const intentAbs = pathResolver.shared(`runtime/recordings/${recording.recording_id}.intent.json`);
  const screenUnavailableReason =
    screenArtifact.status === 'unavailable'
      ? screenArtifact.reason
      : 'screen recording output was not created';
  safeWriteFile(recordingAbs, `${JSON.stringify(recording, null, 2)}\n`);
  safeWriteFile(intentAbs, `${JSON.stringify(intent, null, 2)}\n`);
  const payload = {
    recording,
    intent,
    artifacts: {
      recording_ref: pathResolver.toRepoRelative(recordingAbs),
      intent_ref: pathResolver.toRepoRelative(intentAbs),
      screen_recording: screenArtifact,
    },
    next_actions: [
      `pnpm kyberion recording inspect ${pathResolver.toRepoRelative(recordingAbs)}`,
      ...(capture.event_source === 'native-cg-event-tap' && recording.steps.length > 0
        ? [
            `pnpm kyberion recording review ${pathResolver.toRepoRelative(recordingAbs)} --approve-recording --approve-intent`,
            `pnpm kyberion procedure promote <id> --substrate desktop --recording ${pathResolver.toRepoRelative(recordingAbs)} --intent "<intent>"`,
          ]
        : [ui('recorder:recorder_capture_not_promotable')]),
    ],
  };
  if (argv.json) {
    printOutput(JSON.stringify(payload, null, 2));
    return;
  }
  printOutput(
    ui('recorder:recorder_os_recorded', { recordingRef: payload.artifacts.recording_ref })
  );
  printOutput(ui('recorder:recorder_intent_draft', { intentRef: payload.artifacts.intent_ref }));
  printOutput(
    screenArtifact.status === 'succeeded' && screenRecording.status === 'succeeded'
      ? ui('recorder:recorder_screen_recorded', {
          path: screenRecording.output_path,
          frames: screenRecording.frame_count,
        })
      : ui('recorder:recorder_screen_unavailable', { reason: screenUnavailableReason })
  );
  printOutput(ui('recorder:recorder_next_actions'));
  for (const nextAction of payload.next_actions) printOutput(`  ${nextAction}`);
}

function loadDesktopRecording(ref: string): {
  value?: ReturnType<typeof validateDesktopRecording>['value'];
  error?: string;
} {
  const recordingPath = resolveRecordingPath(ref);
  if (!recordingPath)
    return { error: 'recording path is outside the allowlisted recording stores' };
  if (!safeExistsSync(recordingPath) || !safeLstat(recordingPath).isFile()) {
    return { error: 'recording path must be an existing regular file' };
  }
  try {
    const recording = loadDesktopRecordingAtPath(recordingPath);
    return { value: recording };
  } catch (error) {
    return {
      error: ui('recorder:recorder_recording_read_failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  }
}

function resolveIntentPath(recordingPath: string): string {
  return path.join(
    path.dirname(recordingPath),
    `${path.basename(recordingPath, '.json')}.intent.json`
  );
}

function loadDesktopIntent(
  recording: ReturnType<typeof validateDesktopRecording>['value'],
  recordingPath: string,
  options: { allowReconstruct?: boolean } = {}
) {
  const intentPath = resolveIntentPath(recordingPath);
  const allowReconstruct = options.allowReconstruct !== false;
  if (!safeExistsSync(intentPath)) {
    if (!allowReconstruct)
      throw new Error(
        `intent review artifact not found: ${pathResolver.toRepoRelative(intentPath)}`
      );
    return { intent: reconstructDesktopIntent(recording!), intentPath, reconstructed: true };
  }
  try {
    return {
      intent: loadDesktopIntentDraftAtPath(intentPath, recording?.recording_id),
      intentPath,
      reconstructed: false,
    };
  } catch (error) {
    if (!allowReconstruct)
      throw new Error(
        `failed to read intent review artifact: ${error instanceof Error ? error.message : String(error)}`
      );
    return { intent: reconstructDesktopIntent(recording!), intentPath, reconstructed: true };
  }
}

async function handleRecordingSubcommand(
  action: string,
  ref: string,
  argv: {
    approve?: boolean;
    reject?: boolean;
    approveIntent?: boolean;
    rejectIntent?: boolean;
    reviewer?: string;
    note?: string;
    json?: boolean;
  }
): Promise<void> {
  const loaded = loadDesktopRecording(ref);
  if (!loaded.value) {
    printOutput(
      ui('recorder:recorder_recording_unavailable', { error: loaded.error || 'unknown error' })
    );
    throw new ScriptExitError(1, '', true);
  }
  const recordingPath = resolveRecordingPath(ref)!;
  const currentIntent = loadDesktopIntent(loaded.value, recordingPath);
  if (action === 'inspect') {
    const intent = currentIntent.intent;
    const payload = {
      recording: loaded.value,
      intent,
      intent_ref: pathResolver.toRepoRelative(currentIntent.intentPath),
      intent_source: currentIntent.reconstructed ? 'reconstructed_fallback' : 'persisted_artifact',
      intent_hash_match: Boolean(
        loaded.value.intent_hash && intentDraftHash(intent) === loaded.value.intent_hash
      ),
      next_actions: [`pnpm kyberion recording review ${ref} --approve-recording --approve-intent`],
    };
    if (argv.json) printOutput(JSON.stringify(payload, null, 2));
    else {
      printOutput(
        ui('recorder:recorder_inspect_summary', {
          id: loaded.value.recording_id,
          status: loaded.value.review.status,
        })
      );
      printOutput(
        ui('recorder:recorder_target_summary', {
          name: loaded.value.target.name,
          platform: loaded.value.target.platform,
        })
      );
      printOutput(ui('recorder:recorder_steps_summary', { count: loaded.value.steps.length }));
      printOutput(ui('recorder:recorder_intent_summary', { intent: intent.intent }));
      printOutput(`  ${ui('recorder:recorder_intent_source', { source: payload.intent_source })}`);
      printOutput(
        `  ${ui('recorder:recorder_intent_hash_match', { match: payload.intent_hash_match ? 'true' : 'false' })}`
      );
      for (const step of intent.steps) printOutput(`  - ${step.op}: ${step.title}`);
      printOutput(`${ui('recorder:recorder_next_actions')} ${payload.next_actions[0]}`);
    }
    return;
  }
  if (
    action !== 'review' ||
    (!argv.approve && !argv.reject && !argv.approveIntent && !argv.rejectIntent)
  ) {
    printOutput(ui('recorder:recorder_review_usage'));
    throw new ScriptExitError(1, '', true);
  }
  if (
    Number(Boolean(argv.approve)) + Number(Boolean(argv.reject)) > 1 ||
    Number(Boolean(argv.approveIntent)) + Number(Boolean(argv.rejectIntent)) > 1
  ) {
    printOutput(ui('recorder:recorder_review_usage'));
    throw new ScriptExitError(1, '', true);
  }
  const reviewer = argv.reviewer || 'human:operator';
  let updated =
    argv.approve || argv.reject
      ? ({
          ...loaded.value,
          review: {
            status: argv.approve ? 'approved' : 'rejected',
            reviewer,
            reviewed_at: nowIso(),
            ...(argv.note ? { note: argv.note } : {}),
          },
        } as const)
      : loaded.value;
  let intent = currentIntent.intent;
  if (argv.approveIntent || argv.rejectIntent) {
    intent = reviewDesktopIntent(
      intent,
      argv.approveIntent ? 'approved' : 'rejected',
      reviewer,
      argv.note
    );
    safeWriteFile(currentIntent.intentPath, `${JSON.stringify(intent, null, 2)}\n`);
    updated = {
      ...updated,
      intent_hash: intentDraftHash(intent),
      recording_hash: computeDesktopRecordingHash({
        ...updated,
        intent_hash: intentDraftHash(intent),
      }),
    };
  }
  if (argv.approve || argv.reject || argv.approveIntent || argv.rejectIntent)
    safeWriteFile(recordingPath, `${JSON.stringify(updated, null, 2)}\n`);
  printOutput(
    ui('recorder:recorder_reviewed', { id: updated.recording_id, status: updated.review.status })
  );
  if (argv.approveIntent || argv.rejectIntent)
    printOutput(ui('recorder:recorder_intent_reviewed', { status: intent.review.status }));
}

async function handleProcedureInspect(procedureId: string, json: boolean): Promise<void> {
  const entry = procedureEntryOrReport(procedureId);
  if (!entry) return;
  const loaded = loadProcedureRecording(entry);
  const pipeline =
    entry.substrate === 'desktop'
      ? loadDesktopPipeline(entry.pipeline_ref, { trustResolved: false })
      : null;
  const desktopRecording =
    entry.substrate === 'desktop' && loaded.value ? (loaded.value as DesktopRecording) : undefined;
  const browserRecording =
    entry.substrate === 'browser' && loaded.value
      ? (loaded.value as BrowserExtensionRecording)
      : undefined;
  const payload = {
    procedure: entry,
    recording: loaded.value
      ? {
          review_status: loaded.value.review?.status,
          intent_review_status: desktopRecording
            ? (() => {
                try {
                  return loadDesktopIntent(
                    desktopRecording,
                    resolveAllowlistedRecordingRef(entry.adapter.recording_ref)!,
                    { allowReconstruct: false }
                  ).intent.review.status;
                } catch {
                  return 'missing';
                }
              })()
            : undefined,
          intent_hash: desktopRecording?.intent_hash,
          ...(browserRecording ? { action_count: browserRecording.actions.length } : {}),
          risk_summary: loaded.value.risk_summary,
          ...(desktopRecording ? { step_count: desktopRecording.steps.length } : {}),
        }
      : null,
    recording_error: loaded.error,
    pipeline_error: pipeline && !pipeline.value ? pipeline.errors.join('; ') : undefined,
    next_actions:
      loaded.error || (pipeline && !pipeline.value)
        ? [ui('recorder:recorder_review_repair')]
        : [`pnpm kyberion procedure run ${entry.procedure_id} --inputs '{}'`],
  };
  if (json) {
    printOutput(JSON.stringify(payload, null, 2));
    return;
  }
  printProcedureEntry(entry);
  printOutput(ui('recorder:recorder_pipeline', { path: entry.pipeline_ref }));
  printOutput(
    `  ${ui('recorder:recorder_required_inputs', { inputs: (entry.required_inputs || []).map((input) => input.name).join(', ') || 'none' })}`
  );
  if (loaded.value?.review)
    printOutput(
      ui('recorder:recorder_recording_review_state', { status: loaded.value.review.status })
    );
  if (entry.substrate === 'desktop' && loaded.value) {
    let intentStatus = 'missing';
    try {
      const recordingPath = resolveAllowlistedRecordingRef(entry.adapter.recording_ref);
      if (recordingPath && desktopRecording)
        intentStatus = loadDesktopIntent(desktopRecording, recordingPath, {
          allowReconstruct: false,
        }).intent.review.status;
    } catch {
      // The localized missing state is enough for the operator; execution will explain the repair action.
    }
    printOutput(ui('recorder:recorder_intent_review_state', { status: intentStatus }));
  }
  if (loaded.value?.risk_summary) {
    printOutput(
      ui('recorder:recorder_high_risk_count', {
        count: loaded.value.risk_summary.approval_required_count,
      })
    );
  }
  if (loaded.error) printOutput(ui('recorder:recorder_blocked', { error: loaded.error }));
  if (pipeline && !pipeline.value)
    printOutput(ui('recorder:recorder_pipeline_blocked', { error: pipeline.errors.join('; ') }));
}

export function parseProcedureInputs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  return parseSafeJsonObjectInput(raw, 'procedure inputs') || {};
}

async function handleProcedureRun(
  procedureId: string,
  argv: {
    inputs?: string;
    missionId?: string;
    origin?: string;
    tabId?: string;
    cdpUrl?: string;
    cdpPort?: number;
    headed?: boolean;
    recordVideo?: boolean;
    recordTrace?: boolean;
    correlationId?: string;
    reviewer?: string;
    json?: boolean;
  }
): Promise<void> {
  const entry = procedureEntryOrReport(procedureId);
  if (!entry) return;
  const loaded = loadProcedureRecording(entry);
  if (!loaded.value) {
    printOutput(
      ui('recorder:recorder_execution_failed', { error: loaded.error || 'recording unavailable' })
    );
    throw new ScriptExitError(1, '', true);
  }
  let inputs: Record<string, unknown> = {};
  if (argv.inputs) {
    try {
      inputs = parseProcedureInputs(argv.inputs);
    } catch (error) {
      printOutput(
        ui('recorder:recorder_inputs_invalid', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
      throw new ScriptExitError(1, '', true);
    }
  }
  const missionId =
    argv.missionId || getRegisteredEnvText('MISSION_ID') || `MSN-CLI-${procedureId}`;
  const correlationId = (argv.correlationId || `cli:${procedureId}:${randomUUID()}`)
    .trim()
    .slice(0, 240);
  let result;
  let browserEvidence: unknown;
  if (entry.substrate === 'service') {
    result = await withExecutionContext('surface_runtime', () =>
      dispatchProcedure({
        procedure: entry,
        serviceRecording: loaded.value as ServiceRecording,
        serviceInputs: inputs,
        agentId: 'kyberion-home-cli',
        missionId,
        correlationId,
        channel: 'cli',
      })
    );
  } else if (entry.substrate === 'desktop') {
    let desktopIntent;
    try {
      const recordingPath = resolveAllowlistedRecordingRef(entry.adapter.recording_ref);
      if (!recordingPath) throw new Error(ui('recorder:recorder_recording_ref_invalid'));
      desktopIntent = loadDesktopIntent(loaded.value as DesktopRecording, recordingPath, {
        allowReconstruct: false,
      }).intent;
    } catch (error) {
      printOutput(
        ui('recorder:recorder_execution_failed', {
          error: localizeRecorderError(error instanceof Error ? error.message : String(error)),
        })
      );
      throw new ScriptExitError(1, '', true);
    }
    result = await withExecutionContext('surface_runtime', () =>
      dispatchProcedure({
        procedure: entry,
        desktopRecording: loaded.value as DesktopRecording,
        desktopIntent,
        desktopInputs: Object.fromEntries(
          Object.entries(inputs).map(([key, value]) => [key, String(value)])
        ),
        agentId: 'kyberion-home-cli',
        missionId,
        correlationId,
        channel: 'cli',
      })
    );
  } else if (entry.substrate === 'browser') {
    const browserRecording = loaded.value as BrowserExtensionRecording;
    const origin = argv.origin || browserRecording.tab.origin;
    const tabId = argv.tabId || '';
    const connectOverCdp = Boolean(tabId || argv.cdpUrl || argv.cdpPort);
    const requestedOperations = Array.from(
      new Set(
        browserRecording.actions
          .map((action: { op: string }) => action.op)
          .filter((op: string) => op !== 'sensitive_input_omitted')
      )
    ) as Array<Exclude<BrowserExtensionOperation, 'sensitive_input_omitted'>>;
    let executeBrowserPipeline;
    try {
      const browserActuator = await loadBrowserActuator();
      executeBrowserPipeline = createExecuteBrowserPipeline(browserActuator.handleAction, {
        sessionId: tabId || browserRecording.recording_id,
        headless: argv.headed !== true,
        connectOverCdp,
        cdpUrl: argv.cdpUrl,
        cdpPort: argv.cdpPort,
        recordTrace: argv.recordTrace !== false,
        recordVideo: argv.recordVideo !== false,
        context: {
          procedure_id: entry.procedure_id,
          mission_id: missionId,
          source: 'kyberion-home-cli',
        },
      });
    } catch (error) {
      printOutput(
        ui('recorder:recorder_browser_build_required', {
          error: error instanceof Error ? error.message : String(error),
        })
      );
      throw new ScriptExitError(1, '', true);
    }
    const playwrightEntry = {
      ...entry,
      execution_substrate: 'playwright' as const,
    };
    result = await withExecutionContext('surface_runtime', () =>
      dispatchProcedure({
        procedure: playwrightEntry,
        recording: browserRecording,
        session: {
          kind: 'browser-extension-session.v1',
          mission_id: missionId,
          pipeline_id: entry.pipeline_ref,
          tab_id: tabId,
          origin,
          mode: 'execute',
          recording_id: browserRecording.recording_id,
          requested_operations: requestedOperations,
        },
        agentId: 'kyberion-home-cli',
        missionId,
        pipelineId: entry.pipeline_ref,
        correlationId,
        channel: 'cli',
        executeBrowserPipeline: async (input) => {
          const actuatorResult = await executeBrowserPipeline(input);
          browserEvidence = actuatorResult.context;
          return {
            status: actuatorResult.status,
            results: actuatorResult.results,
            errors: actuatorResult.errors,
          };
        },
      })
    );
  } else {
    printOutput(`${ui('recorder:recorder_unsupported_substrate')}: ${entry.substrate}`);
    throw new ScriptExitError(1, '', true);
  }
  const output = {
    procedure_id: procedureId,
    substrate: entry.substrate,
    mission_id: missionId,
    correlation_id: correlationId,
    recording_ref: entry.adapter.recording_ref,
    ...(browserEvidence ? { evidence: browserEvidence } : {}),
    result,
  };
  if (argv.json) {
    printOutput(JSON.stringify(output, null, 2));
    return;
  }
  printOutput(ui('recorder:recorder_execution_status', { id: procedureId, status: result.status }));
  if (result.approvalRequestId) {
    printOutput(ui('recorder:recorder_execution_approval', { id: result.approvalRequestId }));
    printOutput(ui('recorder:recorder_execution_confirm', { id: result.approvalRequestId }));
  }
  if (result.lease)
    printOutput(ui('recorder:recorder_execution_lease', { lease: JSON.stringify(result.lease) }));
  if (result.errors.length > 0)
    printOutput(
      ui('recorder:recorder_execution_reason', {
        reason: result.errors.map(localizeRecorderError).join('; '),
      })
    );
  if (result.status === 'executed') {
    printOutput(ui('recorder:recorder_execution_feedback', { id: procedureId, correlationId }));
  }
}

function handleProcedurePromote(argv: {
  procedureId?: string;
  substrate?: string;
  recording?: string;
  intent?: string;
  json?: boolean;
}): void {
  if (argv.substrate !== 'desktop' || !argv.procedureId || !argv.recording || !argv.intent) {
    printOutput(ui('recorder:recorder_procedure_promote_usage'));
    throw new ScriptExitError(1, '', true);
  }
  try {
    const promoted = promoteDesktopProcedure({
      procedureId: argv.procedureId,
      recordingRef: argv.recording,
      intentPhrases: [argv.intent],
    });
    const payload = {
      procedure: promoted.procedureEntry,
      catalog_path: promoted.catalogPath,
      pipeline_path: promoted.pipelinePath,
      warnings: promoted.warnings,
      next_actions: [
        `pnpm kyberion intent "${argv.intent}" --substrate desktop`,
        `pnpm kyberion procedure run ${argv.procedureId} --inputs '{}'`,
      ],
    };
    if (argv.json) printOutput(JSON.stringify(payload, null, 2));
    else {
      printOutput(ui('recorder:recorder_promoted', { id: promoted.procedureEntry.procedure_id }));
      printOutput(ui('recorder:recorder_catalog', { path: promoted.catalogPath }));
      printOutput(ui('recorder:recorder_pipeline', { path: promoted.pipelinePath }));
      for (const warning of promoted.warnings || [])
        printOutput(`  warning: ${localizeRecorderWarning(warning)}`);
      printOutput(`${ui('recorder:recorder_next_actions')} ${payload.next_actions[0]}`);
    }
  } catch (error) {
    printOutput(
      ui('recorder:recorder_promotion_failed', {
        error: localizeRecorderError(error instanceof Error ? error.message : String(error)),
      })
    );
    throw new ScriptExitError(1, '', true);
  }
}

function handleProcedureRepair(procedureId: string, json: boolean): void {
  const status = reconcileDesktopPromotionTransaction(procedureId);
  const payload = { procedure_id: procedureId, transaction: status };
  if (json) {
    printOutput(JSON.stringify(payload, null, 2));
    return;
  }
  printOutput(ui('recorder:recorder_transaction_status', { id: procedureId, status }));
  if (status === 'pending') {
    printOutput(ui('recorder:recorder_transaction_repair_unsafe'));
    throw new ScriptExitError(1, '', true);
  }
}

async function mainImpl(args: string[] = []): Promise<void> {
  // The home CLI acts with the operator's own authority — same role the
  // mission controller CLI assumes (inbox/approvals live under active/shared).
  if (!getRegisteredEnvText('MISSION_ROLE')) {
    setRegisteredEnv('MISSION_ROLE', 'mission_controller');
  }
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    printCommands(ui, activePrint);
    return;
  }
  const localeFlagIndex = args.indexOf('--locale');
  if (localeFlagIndex >= 0 && args[localeFlagIndex + 1]) {
    cliLocale = resolveLocale({ explicit: args[localeFlagIndex + 1] });
  }
  // yargs intercepts a literal `help` positional with its own dump — answer
  // with the command table (what the home screen advertises) instead.
  if (args[0] === 'help') {
    printCommands(ui, activePrint);
    return;
  }
  const argv = await createStandardYargs(['node', 'kyberion_home', ...args])
    .option('json', { type: 'boolean', default: false })
    .option('explain', {
      type: 'boolean',
      default: false,
      description: 'show the shared intent-resolution contract before the reply',
    })
    .option('clarify', {
      type: 'boolean',
      default: false,
      description: 'show the shared clarification packet before the reply',
    })
    .option('locale', {
      type: 'string',
      choices: ['en', 'ja', 'qps-ploc'],
      description: 'CLI output locale',
    })
    .option('set', { type: 'string', description: 'notify: set default channel surface:target' })
    .option('read', { type: 'string', description: 'inbox: mark entry as read' })
    .option('read-all', { type: 'boolean', description: 'inbox: mark all unread as read' })
    .option('match', { type: 'string', description: 'inbox: filter --read-all by title/summary' })
    .option('accept', { type: 'string', description: 'inbox: mark entry as accepted' })
    .option('approve', { type: 'string', description: 'approvals: approve request id' })
    .option('deny', { type: 'string', description: 'approvals: reject request id' })
    .option('note', { type: 'string', description: 'approvals: decision note' })
    .option('substrate', { type: 'string', choices: ['browser', 'desktop', 'service'] })
    .option('origin', { type: 'string', description: 'browser procedure origin binding' })
    .option('tab-id', {
      type: 'string',
      description: 'optional tab/session id; with --cdp-url/--cdp-port attaches to live Chrome',
    })
    .option('headed', {
      type: 'boolean',
      default: false,
      description: 'standalone Playwright: launch a visible Chromium window',
    })
    .option('cdp-url', {
      type: 'string',
      description: 'Chrome DevTools endpoint for CLI browser execution',
    })
    .option('cdp-port', {
      type: 'number',
      description: 'Chrome DevTools port for CLI browser execution',
    })
    .option('record-video', {
      type: 'boolean',
      default: true,
      description: 'record browser video evidence when the runtime supports it',
    })
    .option('record-trace', {
      type: 'boolean',
      default: true,
      description: 'record browser trace evidence',
    })
    .option('mission-id', { type: 'string', description: 'mission id for a procedure run' })
    .option('correlation-id', {
      type: 'string',
      description: 'correlation id shared by execution and feedback',
    })
    .option('inputs', { type: 'string', description: 'procedure runtime inputs as a JSON object' })
    .option('outcome', {
      type: 'string',
      choices: ['satisfied', 'partially_satisfied', 'dissatisfied'],
      description: 'execution feedback outcome',
    })
    .option('scenario-id', { type: 'string', description: 'execution feedback scenario id' })
    .option('comment', { type: 'string', description: 'execution feedback comment' })
    .option('correction', { type: 'string', description: 'execution feedback correction' })
    .option('procedure-id', {
      type: 'string',
      description: 'procedure id associated with feedback',
    })
    .option('recording', { type: 'string', description: 'desktop recording path for promotion' })
    .option('intent', {
      type: 'string',
      description: 'natural-language intent phrase for promotion',
    })
    .option('reviewer', { type: 'string', description: 'recording reviewer identity' })
    .option('approve-recording', { type: 'boolean', description: 'approve a desktop recording' })
    .option('reject-recording', { type: 'boolean', description: 'reject a desktop recording' })
    .option('approve-intent', {
      type: 'boolean',
      description: 'approve the reconstructed desktop intent',
    })
    .option('reject-intent', {
      type: 'boolean',
      description: 'reject the reconstructed desktop intent',
    })
    .option('duration', { type: 'number', description: 'desktop recording duration in seconds' })
    .option('fps', { type: 'number', description: 'desktop screen recording frames per second' })
    .option('display-index', {
      type: 'number',
      description: 'desktop display index for screen recording',
    })
    .option('capture-mode', { type: 'string', choices: ['screen', 'focused_window'] })
    .option('requirements', {
      type: 'string',
      description: 'deals: show captured requirements for a deal id',
    })
    .option('ingest-audio', {
      type: 'string',
      description: 'deals: transcribe a call recording into the requirements draft',
    })
    .option('audio', { type: 'string', description: 'deals: audio file path for --ingest-audio' })
    .parseSync();

  cliLocale = resolveLocale({ explicit: argv.locale ? String(argv.locale) : undefined });

  const subcommand = String(argv._[0] || '');
  switch (subcommand) {
    case 'notify':
      if (argv.set) handleNotifySubcommand(String(argv.set));
      else printOutput(JSON.stringify(loadNotificationPreferences(), null, 2));
      return;
    case 'inbox':
      handleInboxSubcommand({
        ...(argv as { read?: string; accept?: string; json?: boolean; match?: string }),
        readAll: Boolean(argv['read-all']),
      });
      return;
    case 'approvals':
      handleApprovalsSubcommand(
        argv as { approve?: string; deny?: string; note?: string; json?: boolean }
      );
      return;
    case 'deals':
      if (argv['ingest-audio']) {
        await handleDealsIngestAudio(
          ui,
          {
            ingestAudio: String(argv['ingest-audio']),
            audio: argv.audio ? String(argv.audio) : undefined,
          },
          activePrint
        );
        return;
      }
      handleDealsSubcommand(ui, argv as { requirements?: string; json?: boolean }, activePrint);
      return;
    case 'ask':
      await handleAskSubcommand(
        argv._.slice(1).map(String).join(' '),
        Boolean(argv.json),
        Boolean(argv.explain),
        Boolean(argv.clarify)
      );
      return;
    case 'doctor':
      // Keep the user-facing single CLI as the canonical doctor entrypoint;
      // runtime-specific checks remain options of the shared doctor command.
      await runDoctor(args.slice(1));
      return;
    case 'intent':
      await handleIntentSubcommand(
        argv._.slice(1).map(String).join(' '),
        argv as { substrate?: string; origin?: string; json?: boolean }
      );
      return;
    case 'procedure': {
      const action = String(argv._[1] || 'list');
      const procedureId = String(argv._[2] || '');
      if (action === 'list') {
        handleProcedureList(argv as { substrate?: string; json?: boolean });
      } else if (action === 'inspect' && procedureId) {
        await handleProcedureInspect(procedureId, Boolean(argv.json));
      } else if (action === 'run' && procedureId) {
        await handleProcedureRun(procedureId, {
          inputs: argv.inputs ? String(argv.inputs) : undefined,
          missionId: argv['mission-id'] ? String(argv['mission-id']) : undefined,
          correlationId: argv['correlation-id'] ? String(argv['correlation-id']) : undefined,
          origin: argv.origin ? String(argv.origin) : undefined,
          tabId: argv['tab-id'] ? String(argv['tab-id']) : undefined,
          headed: Boolean(argv.headed),
          cdpUrl: argv['cdp-url'] ? String(argv['cdp-url']) : undefined,
          cdpPort: typeof argv['cdp-port'] === 'number' ? Number(argv['cdp-port']) : undefined,
          recordVideo: argv['record-video'] !== false,
          recordTrace: argv['record-trace'] !== false,
          json: Boolean(argv.json),
        });
      } else if (action === 'promote' && procedureId) {
        handleProcedurePromote({
          procedureId,
          substrate: argv.substrate ? String(argv.substrate) : undefined,
          recording: argv.recording ? String(argv.recording) : undefined,
          intent: argv.intent ? String(argv.intent) : undefined,
          json: Boolean(argv.json),
        });
      } else if (action === 'repair' && procedureId) {
        handleProcedureRepair(procedureId, Boolean(argv.json));
      } else {
        printOutput(ui('recorder:recorder_procedure_usage'));
        throw new ScriptExitError(1, '', true);
      }
      return;
    }
    case 'record':
      if (String(argv._[1] || '') !== 'desktop') {
        printOutput(ui('recorder:recorder_record_usage'));
        throw new ScriptExitError(1, '', true);
      }
      await handleDesktopRecord({
        duration: typeof argv.duration === 'number' ? argv.duration : undefined,
        fps: typeof argv.fps === 'number' ? argv.fps : undefined,
        displayIndex:
          typeof argv['display-index'] === 'number' ? Number(argv['display-index']) : undefined,
        captureMode: argv['capture-mode'] ? String(argv['capture-mode']) : undefined,
        json: Boolean(argv.json),
      });
      return;
    case 'recording':
      await handleRecordingSubcommand(String(argv._[1] || ''), String(argv._[2] || ''), {
        approve: Boolean(argv['approve-recording']),
        reject: Boolean(argv['reject-recording']),
        approveIntent: Boolean(argv['approve-intent']),
        rejectIntent: Boolean(argv['reject-intent']),
        reviewer: argv.reviewer ? String(argv.reviewer) : undefined,
        note: argv.note ? String(argv.note) : undefined,
        json: Boolean(argv.json),
      });
      return;
    case 'feedback':
      handleFeedbackSubcommand(
        ui,
        {
          intentId: String(argv._[1] || ''),
          scenarioId: argv['scenario-id'] ? String(argv['scenario-id']) : undefined,
          outcome: argv.outcome ? String(argv.outcome) : undefined,
          comment: argv.comment ? String(argv.comment) : undefined,
          correction: argv.correction ? String(argv.correction) : undefined,
          procedureId: argv['procedure-id'] ? String(argv['procedure-id']) : undefined,
          correlationId: argv['correlation-id'] ? String(argv['correlation-id']) : undefined,
          json: Boolean(argv.json),
        },
        activePrint
      );
      return;
    case 'improvements':
      handleImprovements(
        ui,
        {
          approve: argv.approve ? String(argv.approve) : undefined,
          deny: argv.deny ? String(argv.deny) : undefined,
          note: argv.note ? String(argv.note) : undefined,
          json: Boolean(argv.json),
        },
        activePrint
      );
      return;
    case 'help':
      printCommands(ui, activePrint);
      return;
    case '':
      await showHome(ui, Boolean(argv.json), activePrint);
      return;
    default:
      printOutput(ui('recorder:recorder_unknown_subcommand', { subcommand }));
      printCommands(ui, activePrint);
      throw new ScriptExitError(1, '', true);
  }
}

export async function main(args: string[] = [], print: HomePrint = () => undefined): Promise<void> {
  const previousPrint = activePrint;
  activePrint = print;
  try {
    await mainImpl(args);
  } finally {
    activePrint = previousPrint;
  }
}

if (
  isDirectScript(import.meta.url, 'kyberion_home.ts') ||
  isDirectScript(import.meta.url, 'kyberion_home.js')
)
  void defineScript({
    name: 'kyberion',
    flags: [],
    run(context) {
      return main(context.argv, context.print);
    },
  })();
