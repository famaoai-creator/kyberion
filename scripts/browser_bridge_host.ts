/**
 * Kyberion Browser Bridge — Native Messaging host (Phase 2/3)
 *
 * Chrome launches this process over stdio (native messaging name
 * `com.kyberion.browser_bridge`). It is the ONLY trust boundary that may turn a
 * reviewed `browser-recording.v1` draft into an authorized execution lease:
 * schema validation, approval enforcement and lease issuance all happen here,
 * never in the extension.
 *
 * Build:    pnpm build   (emits dist/scripts/browser_bridge_host.js)
 * Launch:   node dist/scripts/browser_bridge_host.js   (via native-host/launch.sh)
 *
 * Wire protocol (Chrome native messaging):
 *   each frame = uint32 little-endian length + UTF-8 JSON body.
 */

import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { defineScript, isDirectScript, setProcessExitCode } from './lib/harness.js';
import {
  buildBrowserExtensionPipelineCandidate,
  compileBrowserRecordingToPipeline,
  enforceBrowserExtensionApproval,
  extendLeaseForMfa,
  issueBrowserExtensionLease,
  segmentRecording,
  subRecordingForSegment,
  preflightBrowserExtensionSession,
  persistBrowserExtensionReceipt,
  validateBrowserExtensionReceipt,
  validateBrowserExtensionRecording,
  validateBrowserExtensionObservation,
  validateBrowserExtensionSessionRequest,
  persistBrowserExtensionObservation,
  loadBrowserExtensionObservations,
  loadBrowserExtensionRecordingAtPath,
} from '@agent/core/browser/browser-extension-bridge';
import {
  applyProcedureDelta,
  classifyFailure,
  createProcedureDelta,
  loadProcedureDelta,
  saveProcedureDelta,
} from '@agent/core/knowledge/procedure-self-repair';
import { compileBrowserRecording } from '@agent/core/browser/browser-recording-compiler';
import { judgeExtensionRun } from '@agent/core/browser/browser-golden-evidence';
import { promoteBrowserProcedure } from '@agent/core/browser/browser-procedure-promotion';
import { dispatchProcedure } from '@agent/core/knowledge/procedure-dispatcher';
import { collectProcedureUserInputs } from '@agent/core/knowledge/procedure-inputs';
import {
  loadProcedures,
  resolveAllowlistedRecordingRef,
  resolveProcedure,
} from '@agent/core/knowledge/procedure-registry';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from '@agent/core/secure-io';
import { auditChain } from '@agent/core/governance/audit-chain';
import {
  createDistillCandidateRecord,
  saveDistillCandidateRecord,
} from '@agent/core/knowledge/distill-candidate-registry';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import {
  BrowserBridgeMailboxError,
  listDeliverableBrowserBridgeRequests,
  listPendingApprovalsForBridge,
  normalizeBrowserBridgeScope,
  respondBrowserBridgeRequest,
  toBrowserBridgeRequestView,
  type BrowserBridgeApprovalSummary,
  type BrowserBridgeScope,
} from '@agent/core/browser/browser-bridge-mailbox';
import { redactObservationText } from '@agent/core/browser/browser-extension-bridge';
import { resolveStorageFloor } from '@agent/core/storage-layout';
import {
  getReasoningBackend,
  delegateTaskWithUntrustedData,
} from '@agent/core/reasoning/reasoning-backend';
import type {
  BrowserExtensionRecording,
  BrowserExtensionLease,
  BrowserExtensionSessionRequest,
} from '@agent/core/browser/browser-extension-bridge';
import type { ProcedureEntry } from '@agent/core/knowledge/procedure-types';
import { nowIso } from '@agent/core/foundation';
import { formatWireError } from '@agent/core/wire-error';
import { parseBrowserBridgeMessage } from './browser-bridge-input.js';

/** Load + allowlist-guard + validate a browser procedure's backing recording. */
function loadBrowserProcedure(procedureId: string): {
  entry?: ProcedureEntry;
  recording?: BrowserExtensionRecording;
  error?: string;
} {
  return withExecutionContext(
    'sovereign_concierge',
    () => {
      const entry = loadProcedures().find((p) => p.procedure_id === procedureId);
      if (!entry) return { error: `Procedure "${procedureId}" not found in catalog` };
      if (entry.substrate !== 'browser')
        return { error: `only browser substrate supported (got: ${entry.substrate})` };
      const recordingPath = resolveAllowlistedRecordingRef(entry.adapter.recording_ref);
      if (!recordingPath)
        return {
          error: `Procedure "${procedureId}" has no allowlisted recording_ref (expected a path under an allowlisted shared or personal browser recordings store)`,
        };
      if (!safeExistsSync(recordingPath) || !safeLstat(recordingPath).isFile()) {
        return { error: `Procedure "${procedureId}" recording must be an existing regular file` };
      }
      try {
        return { entry, recording: loadBrowserExtensionRecordingAtPath(recordingPath) };
      } catch (err) {
        return {
          error: formatWireError(err, 'Failed to load recording'),
        };
      }
    },
    'sovereign'
  );
}

const HOST_VERSION = '0.1.0';

interface HostResponse {
  ok: boolean;
  [key: string]: unknown;
}

function handlePreflight(message: any): HostResponse {
  const preflight = preflightBrowserExtensionSession({
    recording: message.recording,
    session: message.session,
  });
  if (preflight.status === 'blocked') {
    return { ok: false, status: 'blocked', errors: preflight.errors };
  }
  const candidate = buildBrowserExtensionPipelineCandidate(message.recording);
  return {
    ok: true,
    status: preflight.status,
    approval_required: preflight.approvalRequired,
    candidate,
  };
}

function handleRequestExecution(message: any): HostResponse {
  const recording = validateBrowserExtensionRecording(message.recording);
  const session = validateBrowserExtensionSessionRequest(message.session);
  if (!recording.value || !session.value) {
    return { ok: false, error: [...recording.errors, ...session.errors].join('; ') };
  }

  // Approval is enforced inside a governed execution context so the approval
  // store / audit chain records the decision under a real persona.
  const approval = withExecutionContext('surface_runtime', () =>
    enforceBrowserExtensionApproval({
      recording: recording.value!,
      session: session.value!,
      agentId: typeof message.agentId === 'string' ? message.agentId : 'browser-extension',
    })
  );
  if (!approval.allowed) {
    return {
      ok: true,
      status: 'approval_required',
      approval_status: approval.status,
      request_id: approval.requestId,
      message: approval.message,
    };
  }

  const issued = issueBrowserExtensionLease({
    recording: recording.value,
    session: session.value,
    approval,
  });
  if (issued.errors.length > 0 || !issued.lease) {
    return { ok: false, error: issued.errors.join('; ') || 'lease issuance failed' };
  }

  // Confirm the freshly issued lease satisfies the full execute-mode preflight
  // (origin/tab binding, step hashes, expiry) before handing it back.
  const verified = preflightBrowserExtensionSession({
    recording: message.recording,
    session: { ...message.session, mode: 'execute', lease: issued.lease },
    bridgeAvailable: true,
  });
  if (verified.status === 'blocked') {
    return { ok: false, error: verified.errors.join('; ') };
  }
  return { ok: true, status: 'authorized', lease: issued.lease };
}

function handleCompilePipeline(message: any): HostResponse {
  const recording = validateBrowserExtensionRecording(message.recording);
  if (!recording.value) {
    return { ok: false, error: recording.errors.join('; ') };
  }
  const draft = compileBrowserRecordingToPipeline(recording.value, {
    pipelineId: typeof message.pipelineId === 'string' ? message.pipelineId : undefined,
  });
  return { ok: true, status: 'draft', draft };
}

function handleExtendLease(message: any): HostResponse {
  const recording = validateBrowserExtensionRecording(message.recording);
  const session = validateBrowserExtensionSessionRequest(message.session);
  if (!recording.value || !session.value) {
    return { ok: false, error: [...recording.errors, ...session.errors].join('; ') };
  }
  if (!message.lease || typeof message.lease !== 'object') {
    return { ok: false, error: 'extend_lease requires a lease object' };
  }
  const extended = extendLeaseForMfa({
    existingLease: message.lease,
    recording: recording.value,
    session: session.value,
  });
  if (extended.errors.length > 0 || !extended.lease) {
    return { ok: false, error: extended.errors.join('; ') || 'MFA lease extension failed' };
  }
  return { ok: true, status: 'extended', lease: extended.lease };
}

function handleSubmitReceipt(message: any): HostResponse {
  const result = validateBrowserExtensionReceipt(message.receipt);
  if (!result.valid || !result.value) {
    return { ok: false, error: result.errors.join('; ') };
  }
  // Persist the receipt as durable evidence so execution is auditable after the
  // fact (OP-H3). The mission lifecycle may later relocate/aggregate these.
  const receipt = result.value;
  const persisted = withExecutionContext('surface_runtime', () =>
    persistBrowserExtensionReceipt(receipt)
  );
  if (persisted.errors.length > 0) {
    return { ok: false, error: persisted.errors.join('; ') };
  }

  // GAP4 (option C): route the execution into the existing governed flows so a
  // browser automation is no longer an audit silo — WITHOUT creating a mission
  // (zero mission-store churn, fully reversible). (1) record it on the
  // hash-chained audit trail (which Chronos surfaces), and (2) for a successful
  // run, seed a distill-candidate so the procedure can enter the memory/promotion
  // loop. Both are best-effort enrichment; never fail the receipt on them.
  withExecutionContext('surface_runtime', () => {
    try {
      auditChain.record({
        agentId: 'browser-bridge',
        action: 'browser_execution',
        operation: `browser:execute:${receipt.recording_id}`,
        result:
          receipt.status === 'completed'
            ? 'completed'
            : receipt.status === 'blocked'
              ? 'denied'
              : 'failed',
        reason: receipt.summary || `Browser execution ${receipt.status} on ${receipt.origin}`,
        metadata: {
          receipt_id: receipt.receipt_id,
          origin: receipt.origin,
          recording_id: receipt.recording_id,
          lease_id: receipt.lease_id,
          evidence_ref: persisted.path,
        },
      });
    } catch {
      /* audit enrichment is best-effort */
    }

    if (receipt.status === 'completed') {
      try {
        saveDistillCandidateRecord(
          createDistillCandidateRecord({
            source_type: 'task_session',
            tier: 'confidential',
            title: `Browser procedure on ${receipt.origin}`,
            summary: receipt.summary || `Completed browser automation on ${receipt.origin}`,
            status: 'proposed',
            target_kind: 'sop_candidate',
            evidence_refs: [persisted.path || `receipt:${receipt.receipt_id}`],
            metadata: {
              surface: 'browser-extension',
              origin: receipt.origin,
              recording_id: receipt.recording_id,
            },
          })
        );
      } catch {
        /* distill enrichment is best-effort */
      }
    }
  });

  return {
    ok: true,
    status: 'recorded',
    receipt_id: receipt.receipt_id,
    evidence_path: persisted.path,
  };
}

async function handleDispatchProcedure(message: any): Promise<HostResponse> {
  const procedureId = typeof message.procedure_id === 'string' ? message.procedure_id.trim() : '';
  if (!procedureId) return { ok: false, error: 'dispatch_procedure requires procedure_id' };

  const tabId = typeof message.tab_id === 'string' ? message.tab_id : '';
  const origin = typeof message.origin === 'string' ? message.origin : '';

  const loaded = loadBrowserProcedure(procedureId);
  if (loaded.error || !loaded.entry || !loaded.recording) {
    return { ok: false, error: loaded.error ?? 'failed to load procedure' };
  }
  const entry = loaded.entry;
  const recording = { value: loaded.recording };

  const requestedOps = [
    ...new Set(
      recording.value.actions
        .map((a) => a.op)
        .filter(
          (op): op is Exclude<typeof op, 'sensitive_input_omitted'> =>
            op !== 'sensitive_input_omitted'
        )
    ),
  ];
  const session: BrowserExtensionSessionRequest = {
    kind: 'browser-extension-session.v1',
    mission_id: `MSN-PROC-${procedureId}`,
    pipeline_id: entry.pipeline_ref ?? `pipelines/browser/${procedureId}.json`,
    tab_id: tabId,
    origin,
    mode: 'execute',
    recording_id: recording.value.recording_id,
    requested_operations: requestedOps,
  };

  // CR-2 / AR-H1: route through the shared dispatcher so the origin guard,
  // approval gate and lease issuance are NOT reimplemented (and cannot drift).
  const dispatch = await withExecutionContext('surface_runtime', () =>
    dispatchProcedure({
      procedure: entry,
      recording: recording.value!,
      session,
      agentId: 'procedure-dispatcher',
      missionId: session.mission_id,
      pipelineId: session.pipeline_id,
      channel: 'browser-extension',
    })
  );

  if (dispatch.status === 'approval_required') {
    return {
      ok: true,
      status: 'approval_required',
      request_id: dispatch.approvalRequestId,
      message: 'high-risk operations require approval',
    };
  }
  if (dispatch.status !== 'lease_issued') {
    return {
      ok: false,
      status: dispatch.status,
      error: dispatch.errors.join('; ') || 'dispatch failed',
    };
  }

  const compiled = compileBrowserRecording(recording.value, {
    procedureId,
    intentPhrases: entry.intent_phrases,
    recordingRef: entry.adapter.recording_ref,
  });

  // --- Multi-origin (segmented) plan ----------------------------------------
  // The dispatcher already ran the authoritative per-segment preflight. Group
  // the compiled steps into segments at `navigate` boundaries (same split as
  // segmentRecording) and zip with the per-segment origin-bound leases.
  if (dispatch.segments && dispatch.segments.length > 0) {
    const groups: (typeof compiled.compiledSteps)[] = [[]];
    for (const step of compiled.compiledSteps) {
      if (step.op === 'navigate') groups.push([]);
      else groups[groups.length - 1].push(step);
    }
    const segments = dispatch.segments.map((seg) => ({
      segment_index: seg.segment_index,
      origin: seg.origin,
      lease: seg.lease,
      steps: groups[seg.segment_index] ?? [],
    }));
    return {
      ok: true,
      status: 'dispatched_segmented',
      procedure_id: procedureId,
      session,
      segments,
      risk_class: compiled.procedureEntry.risk_class,
      golden_scenario: compiled.goldenScenario,
    };
  }

  // --- Single-origin --------------------------------------------------------
  if (!dispatch.lease) {
    return { ok: false, status: 'blocked', error: 'dispatch returned no lease' };
  }
  // CR-2: re-run the authoritative execute-mode preflight against the issued
  // lease (origin/tab binding, recording_id match, expiry, step-hash coverage)
  // before handing the lease back — exactly as the request_execution path does.
  const verified = preflightBrowserExtensionSession({
    recording: recording.value,
    session: { ...session, lease: dispatch.lease },
    bridgeAvailable: true,
  });
  if (verified.status === 'blocked') {
    return { ok: false, status: 'blocked', error: verified.errors.join('; ') };
  }

  return {
    ok: true,
    status: 'dispatched',
    procedure_id: procedureId,
    lease: dispatch.lease,
    session,
    compiled_steps: compiled.compiledSteps,
    risk_class: compiled.procedureEntry.risk_class,
    golden_scenario: compiled.goldenScenario,
  };
}

/**
 * #1: Report the user inputs a procedure needs, WITHOUT side effects (no lease,
 * no approval). The extension renders these as fields before dispatch.
 */
function handlePrepareProcedure(message: any): HostResponse {
  const procedureId = typeof message.procedure_id === 'string' ? message.procedure_id.trim() : '';
  if (!procedureId) return { ok: false, error: 'prepare_procedure requires procedure_id' };
  const loaded = loadBrowserProcedure(procedureId);
  if (loaded.error || !loaded.entry || !loaded.recording) {
    return { ok: false, error: loaded.error ?? 'failed to load procedure' };
  }
  const inputs = collectProcedureUserInputs(loaded.entry, loaded.recording);
  return {
    ok: true,
    procedure_id: procedureId,
    inputs,
    has_inputs: inputs.length > 0,
    // Start origin (the recording's initial tab origin) + every allowed origin —
    // lets the extension auto-open/connect the right tab before dispatch.
    origin: loaded.recording.tab.origin,
    origins: loaded.entry.target.origins,
  };
}

/** Allowlisted recordings store — where reviewed recordings & deltas are persisted. */
const RECORDINGS_STORE_REL = 'active/shared/runtime/recordings';

/**
 * #2 (loop prerequisite): persist a reviewed recording (or corrective delta
 * recording) into the allowlisted recordings store so it can back a procedure
 * or a delta. Returns the repo-relative ref.
 */
function handleSaveRecording(message: any): HostResponse {
  const recording = validateBrowserExtensionRecording(message.recording);
  if (!recording.value) return { ok: false, error: recording.errors.join('; ') };
  const id = recording.value.recording_id.replace(/[^A-Za-z0-9_.-]/g, '_');
  const rel = `${RECORDINGS_STORE_REL}/${id}.json`;
  const abs = pathResolver.rootResolve(rel);
  try {
    safeMkdir(pathResolver.shared('runtime/recordings'), { recursive: true });
    safeWriteFile(abs, `${JSON.stringify(recording.value, null, 2)}\n`);
  } catch (err) {
    return {
      ok: false,
      error: formatWireError(err, 'Failed to save recording'),
    };
  }
  return { ok: true, recording_ref: rel, recording_id: recording.value.recording_id };
}

/**
 * Register a reviewed extension recording in the personal overlay. The
 * extension never writes catalog files directly: native messaging validates,
 * stores the recording under the personal tier, then promotes it through the
 * shared compiler and trust boundary.
 */
function handlePromoteProcedure(message: any): HostResponse {
  const procedureId = typeof message.procedure_id === 'string' ? message.procedure_id.trim() : '';
  const intentPhrases = Array.isArray(message.intent_phrases) ? message.intent_phrases : [];
  const recording = validateBrowserExtensionRecording(message.recording);
  if (!procedureId) return { ok: false, error: 'promote_procedure requires procedure_id' };
  if (!recording.value) return { ok: false, error: recording.errors.join('; ') };
  if (recording.value.review?.status !== 'approved') {
    return { ok: false, error: 'recording review must be approved before promotion' };
  }
  if (
    intentPhrases.length === 0 ||
    intentPhrases.some(
      (phrase: unknown) => typeof phrase !== 'string' || phrase.trim().length === 0
    )
  ) {
    return { ok: false, error: 'intent_phrases must contain at least one non-empty string' };
  }

  const id = recording.value.recording_id.replace(/[^A-Za-z0-9_.-]/g, '_');
  const recordingRef = `knowledge/personal/browser-recordings/${id}.json`;
  return withExecutionContext(
    'sovereign_concierge',
    () => {
      try {
        safeMkdir(pathResolver.knowledge('personal/browser-recordings'), { recursive: true });
        safeWriteFile(
          assertSafeRepositoryPath(pathResolver.rootResolve(recordingRef), {
            allowMissingLeaf: true,
          }),
          `${JSON.stringify(recording.value, null, 2)}\n`
        );
        const promoted = promoteBrowserProcedure({
          recordingRef,
          procedureId,
          intentPhrases,
          catalogPath: pathResolver.knowledge('personal/browser-procedures.json'),
          status: 'active',
        });
        try {
          auditChain.record({
            agentId: 'browser-extension',
            action: 'procedure_promote',
            operation: 'browser:procedure:promote',
            result: 'allowed',
            reason: `Registered personal browser procedure "${procedureId}"`,
            metadata: { procedure_id: procedureId, recording_ref: recordingRef, scope: 'personal' },
          });
        } catch {
          /* audit enrichment is best-effort */
        }
        return {
          ok: true,
          status: 'registered',
          procedure_id: procedureId,
          recording_ref: recordingRef,
          procedure: promoted.procedureEntry,
        };
      } catch (err) {
        return { ok: false, error: formatWireError(err) };
      }
    },
    'sovereign'
  );
}

/**
 * #2 (loop closure): apply a saved ProcedureDelta — merge the corrective
 * recording into the base recording at the delta's anchor and persist the merged
 * recording (status pending). Returns the merged recording_ref for human-gated
 * re-promotion via promote_procedure. Does NOT auto-activate.
 */
function handleApplyProcedureDelta(message: any): HostResponse {
  const procedureId = typeof message.procedure_id === 'string' ? message.procedure_id.trim() : '';
  const deltaPath = typeof message.delta_path === 'string' ? message.delta_path : '';
  if (!procedureId || !deltaPath)
    return { ok: false, error: 'apply_procedure_delta requires procedure_id and delta_path' };

  const delta = loadProcedureDelta(deltaPath, procedureId);
  if (!delta) return { ok: false, error: `delta not found: ${deltaPath}` };

  const base = loadBrowserProcedure(procedureId);
  if (base.error || !base.recording)
    return { ok: false, error: base.error ?? 'base procedure load failed' };

  const deltaRecAbs = resolveAllowlistedRecordingRef(delta.delta_recording_ref);
  if (!deltaRecAbs)
    return { ok: false, error: 'delta_recording_ref is not in the allowlisted recordings store' };
  if (!safeExistsSync(deltaRecAbs) || !safeLstat(deltaRecAbs).isFile()) {
    return { ok: false, error: 'delta recording must be an existing regular file' };
  }
  let deltaRecording;
  try {
    deltaRecording = loadBrowserExtensionRecordingAtPath(deltaRecAbs);
  } catch (err) {
    return {
      ok: false,
      error: formatWireError(err, 'Failed to load delta recording'),
    };
  }

  const merged = applyProcedureDelta({ baseRecording: base.recording, deltaRecording, delta });
  const saved = withExecutionContext('surface_runtime', () =>
    handleSaveRecording({ recording: merged })
  );
  if (!saved.ok) return saved;
  return {
    ok: true,
    status: 'merged',
    procedure_id: procedureId,
    merged_recording_ref: saved.recording_ref,
    note: 'Merged recording saved with review.status=pending. Re-promote via promote_procedure after review.',
  };
}

/**
 * Self-repair (Layer④). Two modes:
 *   - classify-only (no delta_recording_ref): authoritatively classify a failure
 *     so the extension can show the right repair reason (single source of truth,
 *     replacing the extension's own heuristic — review finding AR-L4).
 *   - persist (delta_recording_ref present + allowlisted): create and save a
 *     ProcedureDelta capturing the corrective recording, closing the loop from a
 *     failure to a durable, promotable correction (AR-H2).
 */
function handleSaveProcedureDelta(message: any): HostResponse {
  const procedureId = typeof message.procedure_id === 'string' ? message.procedure_id.trim() : '';
  if (!procedureId) return { ok: false, error: 'save_procedure_delta requires procedure_id' };
  const anchorStepIndex = Number.isInteger(message.anchor_step_index)
    ? message.anchor_step_index
    : 0;
  const step =
    message.step && typeof message.step === 'object'
      ? {
          op: message.step.op,
          summary: typeof message.step.summary === 'string' ? message.step.summary : '',
        }
      : undefined;
  const reason = classifyFailure(
    new Error(typeof message.error === 'string' ? message.error : ''),
    step
  );

  const deltaRef =
    typeof message.delta_recording_ref === 'string' ? message.delta_recording_ref : '';
  if (!deltaRef) {
    // Classification only — no corrective recording captured yet.
    return { ok: true, status: 'classified', reason };
  }
  if (!resolveAllowlistedRecordingRef(deltaRef)) {
    return {
      ok: false,
      error: 'delta_recording_ref must be inside the allowlisted recordings store',
    };
  }
  const delta = createProcedureDelta({
    procedureId,
    anchorStepIndex,
    anchorSnapshotHash:
      typeof message.anchor_snapshot_hash === 'string' ? message.anchor_snapshot_hash : undefined,
    deltaRecordingRef: deltaRef,
    reason,
  });
  const path = withExecutionContext('surface_runtime', () => {
    const saved = saveProcedureDelta(delta);
    // Make self-repair deltas observable on the governed audit feed (the same
    // mechanism Chronos surfaces) — previously they were written but invisible
    // above the CLI. Best-effort; never fails the delta save.
    try {
      auditChain.record({
        agentId: 'browser-bridge',
        action: 'procedure_self_repair',
        operation: `browser:repair:${procedureId}`,
        result: 'completed',
        reason: `Self-repair delta captured (${reason}) at step ${anchorStepIndex}`,
        metadata: {
          procedure_id: procedureId,
          reason,
          anchor_step_index: anchorStepIndex,
          delta_path: saved,
        },
      });
    } catch {
      /* audit enrichment is best-effort */
    }
    return saved;
  });
  return { ok: true, status: 'delta_saved', reason, delta_path: path };
}

async function handleResolveIntent(message: any): Promise<HostResponse> {
  const intent = typeof message.intent === 'string' ? message.intent.trim() : '';
  if (!intent) return { ok: false, error: 'resolve_intent requires a non-empty intent string' };
  const origin = typeof message.origin === 'string' ? message.origin : undefined;
  const substrate = typeof message.substrate === 'string' ? message.substrate : undefined;
  const resolution = await withExecutionContext(
    'sovereign_concierge',
    () => resolveProcedure(intent, { origin, substrate }),
    'sovereign'
  );
  return { ok: true, resolution };
}

/**
 * Persist a read-only observation (extracted page data) from a governed run.
 * The extension redacts at capture; the bridge re-redacts at this boundary.
 */
function verifyObservationExecutionProof(
  message: any
): { ok: true } | { ok: false; error: string } {
  const observationValidation = validateBrowserExtensionObservation(message.observation);
  if (!observationValidation.value) {
    return { ok: false, error: observationValidation.errors.join('; ') };
  }
  const observation = observationValidation.value;
  let recording: BrowserExtensionRecording | undefined;
  if (message.recording) {
    const validated = validateBrowserExtensionRecording(message.recording);
    if (!validated.value) return { ok: false, error: validated.errors.join('; ') };
    recording = validated.value;
  } else {
    const loaded = loadBrowserProcedure(observation.procedure_id);
    if (loaded.error || !loaded.recording) {
      return { ok: false, error: loaded.error ?? 'observation procedure recording not found' };
    }
    recording = loaded.recording;
  }

  const lease = message.lease as BrowserExtensionLease | undefined;
  const sessionInput =
    message.session && typeof message.session === 'object'
      ? { ...message.session, mode: 'execute', lease }
      : null;
  if (!sessionInput) return { ok: false, error: 'observation execution proof requires a session' };
  const session = validateBrowserExtensionSessionRequest(sessionInput);
  if (!session.value) return { ok: false, error: session.errors.join('; ') };
  if (observation.recording_id !== recording.recording_id) {
    return { ok: false, error: 'observation recording_id does not match execution proof' };
  }
  if (!session.value.lease || observation.lease_id !== session.value.lease.lease_id) {
    return { ok: false, error: 'observation lease_id does not match execution proof' };
  }
  if (session.value.origin !== observation.origin) {
    return { ok: false, error: 'observation origin does not match execution session' };
  }
  if (!recording.actions.some((action) => action.op === 'extract_text_ref')) {
    return { ok: false, error: 'observation proof recording has no extract_text_ref action' };
  }

  // Multi-origin runs use a segment-specific lease. Verify that segment rather
  // than comparing the later origin with the recording's initial origin.
  const segments = segmentRecording(recording);
  const segment = segments.find((candidate) => candidate.origin === observation.origin);
  const proofRecording =
    segments.length > 1 && segment ? subRecordingForSegment(recording, segment) : recording;
  const proofSession = { ...session.value, origin: observation.origin };
  if (proofSession.lease.origin && proofSession.lease.origin !== observation.origin) {
    return { ok: false, error: 'observation lease origin does not match observation origin' };
  }
  const preflight = preflightBrowserExtensionSession({
    recording: proofRecording,
    session: proofSession,
    bridgeAvailable: true,
  });
  return preflight.status === 'blocked'
    ? { ok: false, error: preflight.errors.join('; ') }
    : { ok: true };
}

/**
 * Judge a completed extension run against the procedure's golden scenario.
 * The extension sends the matching page elements; the verdict is decided and
 * recorded here, never in the extension.
 */
function handleSubmitGoldenEvidence(message: any): HostResponse {
  const procedureId = typeof message.procedure_id === 'string' ? message.procedure_id.trim() : '';
  if (!procedureId) return { ok: false, error: 'submit_golden_evidence requires procedure_id' };
  const loaded = loadBrowserProcedure(procedureId);
  if (loaded.error || !loaded.entry || !loaded.recording) {
    return { ok: false, error: loaded.error ?? 'failed to load procedure' };
  }
  const { entry, recording } = loaded;
  const judged = withExecutionContext(
    'sovereign_concierge',
    () =>
      judgeExtensionRun({
        procedure: entry,
        recordingId: recording.recording_id,
        receiptId: message.receipt_id,
        elements: message.elements,
      }),
    'sovereign'
  );
  if (!judged.ok) return judged;
  return {
    ok: true,
    status: judged.verdict ? 'judged' : 'no_golden_scenario',
    procedure_id: procedureId,
    ...(judged.verdict ? { golden: judged.verdict } : {}),
  };
}

function handleSubmitObservation(message: any): HostResponse {
  const proof = withExecutionContext(
    'sovereign_concierge',
    () => verifyObservationExecutionProof(message),
    'sovereign'
  );
  if (!proof.ok) return proof;
  const persisted = withExecutionContext(
    'sovereign_concierge',
    () => persistBrowserExtensionObservation(message.observation),
    'sovereign'
  );
  if (persisted.errors.length > 0) {
    return { ok: false, error: persisted.errors.join('; ') };
  }
  const observation = validateBrowserExtensionObservation(message.observation).value!;
  withExecutionContext(
    'sovereign_concierge',
    () => {
      try {
        auditChain.record({
          agentId: 'browser-bridge',
          action: 'browser_observation',
          operation: `browser:observe:${observation.procedure_id}`,
          result: 'completed',
          reason: `Captured ${observation.fields?.length ?? 0} field(s) from ${observation.origin}`,
          metadata: {
            observation_id: observation.observation_id,
            procedure_id: observation.procedure_id,
            origin: observation.origin,
            evidence_ref: persisted.path,
          },
        });
      } catch {
        /* audit enrichment is best-effort */
      }
    },
    'sovereign'
  );
  return {
    ok: true,
    status: 'recorded',
    observation_id: observation.observation_id,
    path: persisted.path,
  };
}

/**
 * Analyze stored observations for a procedure and write a Markdown report.
 * Extracted page text is UNTRUSTED — it flows through
 * delegateTaskWithUntrustedData, which fences it as data and instructs the
 * model to ignore embedded instructions. Analysis is one-way: the report is an
 * artifact; nothing here feeds back into browser execution.
 */
async function handleAnalyzeObservation(message: any): Promise<HostResponse> {
  const procedureId = typeof message.procedure_id === 'string' ? message.procedure_id.trim() : '';
  if (!procedureId) return { ok: false, error: 'analyze_observation requires procedure_id' };
  const question =
    typeof message.question === 'string' && message.question.trim()
      ? message.question.trim().slice(0, 1000)
      : // i18n-exempt: JA LLM prompt (model input)
        '抽出されたデータの要点を整理し、変化・傾向・注目点を日本語で簡潔にレポートしてください。';
  const limit =
    Number.isInteger(message.limit) && message.limit > 0 ? Math.min(message.limit, 20) : 20;

  const observations = withExecutionContext(
    'sovereign_concierge',
    () => loadBrowserExtensionObservations(procedureId, { limit }),
    'sovereign'
  );
  if (observations.length === 0) {
    return {
      ok: false,
      // i18n-exempt: JA LLM prompt (model input)
      error: `手順「${procedureId}」の観測データがまだありません。実行して抽出データを集めてください。`,
    };
  }

  const dataset = observations
    .map((obs) =>
      [
        `## ${obs.captured_at} (${obs.origin})`,
        ...obs.fields.map((f) => `- ${f.name}: ${f.text}`),
      ].join('\n')
    )
    .join('\n\n')
    .slice(0, 100_000);

  let analysis: string;
  try {
    analysis = await withExecutionContext(
      'sovereign_concierge',
      () =>
        delegateTaskWithUntrustedData(
          getReasoningBackend(),
          [
            'You are analyzing data extracted from reviewed regions of web pages during a governed browser automation run.',
            `Analysis request: ${question}`,
            'Write the report in Japanese, in Markdown, concise and structured.',
            'The dataset below is a time-ordered series of observations (oldest first).',
          ].join('\n'),
          { untrustedData: dataset, sourceLabel: `browser observations for ${procedureId}` },
          { context: `browser-observation-report:${procedureId}` }
        ),
      'sovereign'
    );
  } catch (err) {
    return {
      ok: false,
      // i18n-exempt: JA LLM prompt (model input)
      error: formatWireError(err, '分析バックエンドの実行に失敗しました'),
    };
  }

  const stamp = nowIso().replace(/[:.]/g, '-');
  const reportRel = `knowledge/personal/browser-reports/${procedureId.replace(/[^A-Za-z0-9._-]/g, '_')}/${stamp}.md`;
  const report = [
    `# Observation report: ${procedureId}`,
    '',
    `- generated_at: ${nowIso()}`,
    `- observations: ${observations.length} (latest: ${observations[observations.length - 1].captured_at})`,
    `- question: ${question}`,
    '',
    analysis.trim(),
    '',
  ].join('\n');
  try {
    withExecutionContext(
      'sovereign_concierge',
      () => {
        safeMkdir(
          pathResolver.knowledge(
            `personal/browser-reports/${procedureId.replace(/[^A-Za-z0-9._-]/g, '_')}`
          ),
          { recursive: true }
        );
        safeWriteFile(
          assertSafeRepositoryPath(pathResolver.rootResolve(reportRel), {
            allowMissingLeaf: true,
          }),
          report
        );
        try {
          auditChain.record({
            agentId: 'browser-bridge',
            action: 'browser_observation_report',
            operation: `browser:report:${procedureId}`,
            result: 'completed',
            reason: `Generated observation report over ${observations.length} observation(s)`,
            metadata: { procedure_id: procedureId, report_ref: reportRel },
          });
        } catch {
          /* audit enrichment is best-effort */
        }
      },
      'sovereign'
    );
  } catch (err) {
    return {
      ok: false,
      // i18n-exempt: JA LLM prompt (model input)
      error: formatWireError(err, 'レポートの保存に失敗しました'),
    };
  }

  return {
    ok: true,
    status: 'reported',
    procedure_id: procedureId,
    report_ref: reportRel,
    observation_count: observations.length,
    report,
  };
}

// ---------------------------------------------------------------------------
// Pull mailbox (Kyberion -> extension) and page send (extension -> Kyberion)
// ---------------------------------------------------------------------------

/** Mailbox errors carry a code and a message written for the wire; others are masked. */
function mailboxFailure(err: unknown, fallback: string): HostResponse {
  if (err instanceof BrowserBridgeMailboxError) {
    return { ok: false, code: err.code, error: describeMailboxError(err) };
  }
  return { ok: false, error: formatWireError(err, fallback) };
}

function describeMailboxError(err: BrowserBridgeMailboxError): string {
  return String(err.message);
}

function recordBridgeAudit(entry: {
  action: string;
  operation: string;
  result: 'completed' | 'denied' | 'failed';
  reason: string;
  metadata: Record<string, unknown>;
}): void {
  withExecutionContext(
    'sovereign_concierge',
    () => {
      try {
        auditChain.record({ agentId: 'browser-bridge', ...entry });
      } catch {
        /* audit enrichment is best-effort */
      }
    },
    'sovereign'
  );
}

/**
 * poll_requests: deliverable mailbox requests (pending → delivered, lapsed →
 * expired) plus a read-only pending-approval summary. Only new deliveries are
 * audited so the side panel's 5 s fast poll does not flood the audit chain.
 *
 * Single-operator channel: this runs under the sovereign concierge role and
 * returns the requests of every tier/tenant partition to the one operator's
 * allowlisted extension. The mailbox's tier/tenant partitioning is placement,
 * not viewer isolation — tenant observe requests are bounded instead by their
 * mandatory allowed_origins (see browser-bridge-mailbox.ts).
 */
function handlePollRequests(): HostResponse {
  const now = new Date();
  const requests = withExecutionContext(
    'sovereign_concierge',
    () => listDeliverableBrowserBridgeRequests({ now }),
    'sovereign'
  );
  let approvals: BrowserBridgeApprovalSummary[] = [];
  let approvalsUnavailable = false;
  try {
    approvals = withExecutionContext(
      'sovereign_concierge',
      () => listPendingApprovalsForBridge({ now }),
      'sovereign'
    );
  } catch {
    approvalsUnavailable = true;
  }
  const delivered = requests.filter((request) => request.delivered_at === now.toISOString());
  if (delivered.length > 0) {
    recordBridgeAudit({
      action: 'browser_bridge_deliver',
      operation: 'browser:bridge:poll',
      result: 'completed',
      reason: `Delivered ${delivered.length} mailbox request(s) to the extension`,
      metadata: {
        request_ids: delivered.map((request) => request.request_id),
        request_kinds: delivered.map((request) => request.request_kind),
      },
    });
  }
  return {
    ok: true,
    requests: requests.map(toBrowserBridgeRequestView),
    approvals,
    ...(approvalsUnavailable ? { approvals_unavailable: true } : {}),
  };
}

/** respond_request: the extension's answer, validated and re-redacted by the mailbox. */
function handleRespondRequest(message: any): HostResponse {
  const requestId = typeof message.request_id === 'string' ? message.request_id.trim() : '';
  const status = message.status;
  if (!requestId)
    return { ok: false, code: 'invalid_input', error: 'respond_request requires request_id' };
  try {
    const updated = withExecutionContext(
      'sovereign_concierge',
      () =>
        respondBrowserBridgeRequest(requestId, {
          status,
          ...(message.result !== undefined ? { result: message.result } : {}),
          ...(message.error !== undefined ? { error: String(message.error) } : {}),
          ...(message.origin !== undefined ? { origin: String(message.origin) } : {}),
        }),
      'sovereign'
    );
    recordBridgeAudit({
      action: 'browser_bridge_respond',
      operation: `browser:bridge:respond:${updated.request_kind}`,
      result: updated.status === 'completed' ? 'completed' : 'denied',
      reason: `Extension answered ${updated.request_kind} request with ${updated.status}`,
      metadata: {
        request_id: updated.request_id,
        request_kind: updated.request_kind,
        status: updated.status,
        ...(updated.response?.origin ? { origin: updated.response.origin } : {}),
      },
    });
    return { ok: true, request_id: updated.request_id, status: updated.status };
  } catch (err) {
    recordBridgeAudit({
      action: 'browser_bridge_respond',
      operation: 'browser:bridge:respond',
      result: 'denied',
      reason: 'Extension response rejected by the mailbox',
      metadata: {
        request_id: requestId.slice(0, 80),
        code: err instanceof BrowserBridgeMailboxError ? err.code : 'internal',
      },
    });
    return mailboxFailure(err, 'respond_request failed');
  }
}

const SEND_PAGE_MAX_TEXT = 30_000;

function canonicalPageOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}

interface SendPageInput {
  mode: 'intent' | 'knowledge';
  scope: BrowserBridgeScope;
  title: string;
  urlOrigin: string;
  text: string;
  selectionOnly: boolean;
  note?: string;
}

function parseSendPage(message: any): SendPageInput | { error: string } {
  if (message.mode !== 'intent' && message.mode !== 'knowledge') {
    return { error: 'send_page mode must be intent|knowledge' };
  }
  if (message.tier === 'public' && message.confirm_public !== true) {
    return { error: 'public tier requires confirm_public: true' };
  }
  let scope: BrowserBridgeScope;
  try {
    scope = normalizeBrowserBridgeScope({
      tier: message.tier,
      ...(typeof message.tenant_slug === 'string' && message.tenant_slug.trim()
        ? { tenant_slug: message.tenant_slug }
        : {}),
    });
  } catch (err) {
    return {
      error: err instanceof BrowserBridgeMailboxError ? describeMailboxError(err) : 'invalid scope',
    };
  }
  const urlOrigin = canonicalPageOrigin(message.url_origin);
  if (!urlOrigin) return { error: 'url_origin must be a canonical http(s) origin' };
  if (typeof message.title !== 'string' || message.title.length > 300) {
    return { error: 'title must be a string of at most 300 characters' };
  }
  if (typeof message.text !== 'string' || !message.text.trim()) {
    return { error: 'text must be a non-empty string' };
  }
  if (message.text.length > SEND_PAGE_MAX_TEXT) {
    return { error: `text exceeds ${SEND_PAGE_MAX_TEXT} characters` };
  }
  if (typeof message.selection_only !== 'boolean') {
    return { error: 'selection_only must be a boolean' };
  }
  if (
    message.note !== undefined &&
    (typeof message.note !== 'string' || message.note.length > 1000)
  ) {
    return { error: 'note must be a string of at most 1000 characters' };
  }
  // The extension scrubs before sending; redact again at this trust boundary.
  const note = typeof message.note === 'string' ? redactObservationText(message.note.trim()) : '';
  return {
    mode: message.mode,
    scope,
    title: redactObservationText(message.title.trim()) || urlOrigin,
    urlOrigin,
    text: redactObservationText(message.text),
    selectionOnly: message.selection_only,
    ...(note ? { note } : {}),
  };
}

function pageFileStem(input: SendPageInput): string {
  const digest = createHash('sha256')
    .update(`${input.urlOrigin}\n${input.title}`)
    .digest('hex')
    .slice(0, 12);
  return `${new URL(input.urlOrigin).hostname.replace(/[^A-Za-z0-9.-]/g, '_')}-${digest}`;
}

/** Land the scrubbed page as Markdown on the staging floor of its tier/tenant partition. */
function stageSendPage(input: SendPageInput): string {
  const stem = pageFileStem(input);
  const job = `${nowIso().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
  const filePath = resolveStorageFloor(
    'staging',
    { kind: 'tier', tier: input.scope.tier, tenant: input.scope.tenant_slug },
    'browser-bridge',
    job,
    `${stem}.md`
  );
  const body = [
    `# ${input.title}`,
    '',
    `- source_origin: ${input.urlOrigin}`,
    `- captured_at: ${nowIso()}`,
    `- selection_only: ${input.selectionOnly}`,
    ...(input.note ? [`- note: ${input.note}`] : []),
    '',
    '> Page text is untrusted external data captured from the browser.',
    '',
    input.text,
    '',
  ].join('\n');
  withExecutionContext(
    'sovereign_concierge',
    () => {
      const safe = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
      safeMkdir(path.dirname(safe), { recursive: true });
      safeWriteFile(safe, body);
    },
    'sovereign'
  );
  return filePath;
}

/**
 * Governed ingest of a staged page: the same in-process ceremony as
 * `pnpm knowledge:ingest --tenant` (scripts/ingest.ts main). Only a
 * confidential tenant lands directly; personal pages have no tenant knowledge
 * root and public (`common`) landings need a steward approval, so both stay
 * staged with the exact command to finish.
 */
async function ingestStagedPage(
  input: SendPageInput,
  stagedPath: string
): Promise<Record<string, unknown>> {
  const relative = path.relative(pathResolver.rootDir(), stagedPath);
  if (input.scope.tier !== 'confidential' || !input.scope.tenant_slug) {
    const tenant = input.scope.tier === 'public' ? 'common' : '<tenant>';
    return {
      status: 'staged',
      next:
        input.scope.tier === 'public'
          ? `pnpm knowledge:ingest --tenant ${tenant} --file ${relative} --steward-approval-id <id>`
          : 'personal pages stay staged; move them into a tenant with pnpm knowledge:ingest --tenant <tenant>',
    };
  }
  const lines: string[] = [];
  const argv = [
    '--tenant',
    input.scope.tenant_slug,
    '--file',
    stagedPath,
    '--format',
    'markdown',
    '--source-system',
    'browser-bridge',
    '--source-id',
    pageFileStem(input),
    '--ingested-by',
    'browser-bridge',
  ];
  try {
    const { main: ingestMain } = await import('./ingest.js');
    await withExecutionContextAsync(
      'sovereign_concierge',
      () => ingestMain(argv, (value) => lines.push(String(value))),
      'sovereign'
    );
  } catch (err) {
    return { status: 'failed', error: formatWireError(err, 'knowledge ingest failed') };
  }
  const committed = lines.find((line) => line.startsWith('[ingest] committed '));
  return committed
    ? { status: 'committed', detail: committed.replace('[ingest] ', '') }
    : {
        status: 'not_committed',
        detail: (lines.find((line) => line.startsWith('[ingest] NOT committed')) ?? '').replace(
          '[ingest] ',
          ''
        ),
      };
}

/**
 * send_page (B3): the user explicitly sends the current page (or selection)
 * from the side panel. `intent` resolves the user's note through the same
 * procedure resolver as resolve_intent; `knowledge` stages the scrubbed text
 * and runs the governed ingest ceremony.
 */
async function handleSendPage(message: any): Promise<HostResponse> {
  const parsed = parseSendPage(message);
  if ('error' in parsed) {
    recordBridgeAudit({
      action: 'browser_bridge_send_page',
      operation: 'browser:bridge:send_page',
      result: 'denied',
      reason: parsed.error,
      metadata: { mode: String(message.mode ?? ''), tier: String(message.tier ?? '') },
    });
    return { ok: false, code: 'invalid_input', error: parsed.error };
  }
  const page = {
    title: parsed.title,
    url_origin: parsed.urlOrigin,
    text_chars: parsed.text.length,
    selection_only: parsed.selectionOnly,
  };
  const auditBase = {
    mode: parsed.mode,
    tier: parsed.scope.tier,
    ...(parsed.scope.tenant_slug ? { tenant_slug: parsed.scope.tenant_slug } : {}),
    origin: parsed.urlOrigin,
    text_chars: parsed.text.length,
    selection_only: parsed.selectionOnly,
  };

  if (parsed.mode === 'intent') {
    const intent = parsed.note || parsed.title;
    const resolved = await handleResolveIntent({ intent, origin: parsed.urlOrigin });
    recordBridgeAudit({
      action: 'browser_bridge_send_page',
      operation: 'browser:bridge:send_page:intent',
      result: resolved.ok ? 'completed' : 'failed',
      reason: `Page sent as intent from ${parsed.urlOrigin}`,
      metadata: auditBase,
    });
    return resolved.ok
      ? { ok: true, mode: 'intent', resolution: resolved.resolution, page }
      : resolved;
  }

  let stagedPath: string;
  try {
    stagedPath = stageSendPage(parsed);
  } catch (err) {
    recordBridgeAudit({
      action: 'browser_bridge_send_page',
      operation: 'browser:bridge:send_page:knowledge',
      result: 'failed',
      reason: 'Staging the page failed',
      metadata: auditBase,
    });
    return { ok: false, error: formatWireError(err, 'Failed to stage page') };
  }
  const ingest = await ingestStagedPage(parsed, stagedPath);
  const stagedRef = path.relative(pathResolver.rootDir(), stagedPath);
  recordBridgeAudit({
    action: 'browser_bridge_send_page',
    operation: 'browser:bridge:send_page:knowledge',
    result: ingest.status === 'failed' ? 'failed' : 'completed',
    reason: `Page from ${parsed.urlOrigin} staged for knowledge (${String(ingest.status)})`,
    metadata: { ...auditBase, staged_ref: stagedRef, ingest_status: ingest.status },
  });
  return { ok: true, mode: 'knowledge', staged_ref: stagedRef, ingest, page };
}

export function handle(message: any): HostResponse | Promise<HostResponse> {
  switch (message?.type) {
    case 'ping':
      return { ok: true, pong: true, host_version: HOST_VERSION };
    case 'preflight':
      return handlePreflight(message);
    case 'request_execution':
      return handleRequestExecution(message);
    case 'compile_pipeline':
      return handleCompilePipeline(message);
    case 'extend_lease':
      return handleExtendLease(message);
    case 'submit_receipt':
      return handleSubmitReceipt(message);
    case 'dispatch_procedure':
      return handleDispatchProcedure(message);
    case 'prepare_procedure':
      return handlePrepareProcedure(message);
    case 'save_recording':
      return handleSaveRecording(message);
    case 'promote_procedure':
      return handlePromoteProcedure(message);
    case 'apply_procedure_delta':
      return handleApplyProcedureDelta(message);
    case 'save_procedure_delta':
      return handleSaveProcedureDelta(message);
    case 'resolve_intent':
      return handleResolveIntent(message);
    case 'submit_observation':
      return handleSubmitObservation(message);
    case 'analyze_observation':
      return handleAnalyzeObservation(message);
    case 'submit_golden_evidence':
      return handleSubmitGoldenEvidence(message);
    case 'poll_requests':
      return handlePollRequests();
    case 'respond_request':
      return handleRespondRequest(message);
    case 'send_page':
      return handleSendPage(message);
    default:
      return { ok: false, error: `Unsupported message type: ${String(message?.type)}` };
  }
}

function writeFrame(payload: HostResponse): Promise<void> {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return new Promise((resolve, reject) => {
    process.stdout.write(Buffer.concat([header, json]), (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function startBrowserBridgeHost(): void {
  let inbox = Buffer.alloc(0);
  let inputEnded = false;
  let pendingResponses = 0;

  function exitWhenDrained(): void {
    // Native Messaging one-shot calls may close stdin immediately after sending
    // the request. Let stdout finish and allow Node to exit naturally; an
    // explicit process.exit can make Chrome report "Native host has exited"
    // before it has consumed the response frame.
    if (inputEnded && pendingResponses === 0) process.stdin.pause();
  }

  function drain(): void {
    while (inbox.length >= 4) {
      const length = inbox.readUInt32LE(0);
      if (inbox.length < 4 + length) return;
      const body = inbox.subarray(4, 4 + length);
      inbox = inbox.subarray(4 + length);
      pendingResponses += 1;
      Promise.resolve()
        .then(() => handle(parseBrowserBridgeMessage(body.toString('utf8'))))
        .then((response) => writeFrame(response))
        .catch((error) =>
          writeFrame({ ok: false, error: formatWireError(error, 'Browser bridge request failed') })
        )
        .finally(() => {
          pendingResponses -= 1;
          exitWhenDrained();
        });
    }
  }

  process.stdin.on('data', (chunk: Buffer) => {
    inbox = Buffer.concat([inbox, chunk]);
    drain();
  });
  process.stdin.on('end', () => {
    inputEnded = true;
    exitWhenDrained();
  });
  process.stdin.on('error', () => setProcessExitCode(1));
}

const runBrowserBridgeHost = defineScript({
  name: 'browser-bridge-host',
  flags: [],
  run() {
    startBrowserBridgeHost();
  },
});

if (
  isDirectScript(import.meta.url, 'browser_bridge_host.ts') ||
  isDirectScript(import.meta.url, 'browser_bridge_host.js')
)
  void runBrowserBridgeHost();
