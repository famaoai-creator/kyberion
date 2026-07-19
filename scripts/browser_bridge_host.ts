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
import {
  buildBrowserExtensionPipelineCandidate,
  applyProcedureDelta,
  classifyFailure,
  compileBrowserRecording,
  compileBrowserRecordingToPipeline,
  promoteBrowserProcedure,
  createProcedureDelta,
  dispatchProcedure,
  enforceBrowserExtensionApproval,
  extendLeaseForMfa,
  issueBrowserExtensionLease,
  loadProcedureDelta,
  preflightBrowserExtensionSession,
  persistBrowserExtensionReceipt,
  collectProcedureUserInputs,
  loadProcedures,
  resolveAllowlistedRecordingRef,
  resolveProcedure,
  saveProcedureDelta,
  pathResolver,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  auditChain,
  createDistillCandidateRecord,
  saveDistillCandidateRecord,
  validateBrowserExtensionReceipt,
  validateBrowserExtensionRecording,
  validateBrowserExtensionSessionRequest,
  withExecutionContext,
  type BrowserExtensionRecording,
  type BrowserExtensionSessionRequest,
  type ProcedureEntry,
} from '@agent/core';

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
      let raw: unknown;
      try {
        raw = JSON.parse(safeReadFile(recordingPath) as string);
      } catch (err) {
        return {
          error: `Failed to load recording: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const rec = validateBrowserExtensionRecording(raw);
      if (!rec.value) return { error: rec.errors.join('; ') };
      return { entry, recording: rec.value };
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
  return { ok: true, procedure_id: procedureId, inputs, has_inputs: inputs.length > 0 };
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
      error: `failed to save recording: ${err instanceof Error ? err.message : String(err)}`,
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
          pathResolver.rootResolve(recordingRef),
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
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
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

  const delta = loadProcedureDelta(deltaPath);
  if (!delta) return { ok: false, error: `delta not found: ${deltaPath}` };

  const base = loadBrowserProcedure(procedureId);
  if (base.error || !base.recording)
    return { ok: false, error: base.error ?? 'base procedure load failed' };

  const deltaRecAbs = resolveAllowlistedRecordingRef(delta.delta_recording_ref);
  if (!deltaRecAbs)
    return { ok: false, error: 'delta_recording_ref is not in the allowlisted recordings store' };
  let deltaRecording;
  try {
    const parsed = validateBrowserExtensionRecording(
      JSON.parse(safeReadFile(deltaRecAbs) as string)
    );
    if (!parsed.value)
      return { ok: false, error: `delta recording invalid: ${parsed.errors.join('; ')}` };
    deltaRecording = parsed.value;
  } catch (err) {
    return {
      ok: false,
      error: `failed to load delta recording: ${err instanceof Error ? err.message : String(err)}`,
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

function handle(message: any): HostResponse | Promise<HostResponse> {
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
      .then(() => handle(JSON.parse(body.toString('utf8'))))
      .then((response) => writeFrame(response))
      .catch((error) =>
        writeFrame({ ok: false, error: error instanceof Error ? error.message : String(error) })
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
process.stdin.on('error', () => process.exit(1));
