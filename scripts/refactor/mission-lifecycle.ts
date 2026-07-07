/**
 * scripts/refactor/mission-lifecycle.ts
 * Delegation, verification, import, and finalization helpers for missions.
 */

import * as path from 'node:path';
import {
  addInboxEntry,
  notifyOperator,
  findMissionPath,
  customerResolver,
  grantAccess,
  grantAccessGuarded,
  createActuatorTrace,
  finalizeActuatorTrace,
  buildCompletionNextAction,
  ledger,
  logger,
  latestSnapshot,
  pathResolver,
  queueMissionMemoryPromotionCandidate,
  summarizeReviewGateVerdicts,
  safeExec,
  safeAppendFileSync,
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  recordMissionGateOverride,
  writeMissionGateRecord,
} from '@agent/core';
import { reconcileCompletion } from '@agent/core/intent-reconciliation';
import { loadState, saveState } from './mission-state.js';
import {
  readTrustLedger,
  recordAgentRuntimeEvent,
  updateTrustScore,
  validateMissionQuality,
} from './mission-governance.js';
import {
  emitMissionLifecycleIntentSnapshot,
  evaluateMissionIntentDrift,
} from './mission-intent-delta.js';

function collectMissionEvidence(missionDir: string): Array<{ ref: string; text?: string }> {
  const evidenceDir = path.join(missionDir, 'evidence');
  if (!safeExistsSync(evidenceDir)) return [];
  return safeReaddir(evidenceDir)
    .filter((entry) => entry !== '.gitkeep')
    .map((entry) => {
      const ref = path.join(missionDir, 'evidence', entry);
      let text: string | undefined;
      try {
        if (safeExistsSync(ref)) {
          text = String(safeReadFile(ref, { encoding: 'utf8' })).slice(0, 2000);
        }
      } catch (_) {}
      return { ref, text };
    });
}

function publishMeetingDeliverablesIfNeeded(input: {
  missionId: string;
  missionDir: string;
  state: any;
  completionNextAction: any;
  traceCtx: ReturnType<typeof createActuatorTrace>;
}): void {
  if (input.state.mission_type !== 'meeting_facilitation') return;

  let activeCustomerSlug: string | null = null;
  try {
    activeCustomerSlug = customerResolver.activeCustomer(process.env);
  } catch (err: any) {
    logger.warn(
      `⚠️ [DELIVERY] Meeting deliverables skipped for ${input.missionId}: ${err?.message || err}`
    );
    input.traceCtx.addEvent('meeting_delivery.skipped', {
      reason: 'invalid_customer_slug',
    });
    return;
  }

  const tenantSlug = String(input.state.tenant_slug || '').trim();
  if (!tenantSlug || !activeCustomerSlug || activeCustomerSlug !== tenantSlug) {
    input.traceCtx.addEvent('meeting_delivery.skipped', {
      reason: !tenantSlug ? 'missing_tenant_slug' : 'customer_mismatch',
    });
    return;
  }

  const customerRoot = customerResolver.customerRoot('', process.env);
  if (!customerRoot || !safeExistsSync(customerRoot)) {
    logger.warn(
      `⚠️ [DELIVERY] Meeting deliverables skipped for ${input.missionId}: customer root missing for ${tenantSlug}.`
    );
    input.traceCtx.addEvent('meeting_delivery.skipped', {
      reason: 'customer_root_missing',
    });
    return;
  }

  const evidenceDir = path.join(input.missionDir, 'evidence');
  const deliverablesRoot = path.join(customerRoot, 'deliverables');
  const missionDeliverablesDir = path.join(deliverablesRoot, input.missionId);
  safeMkdir(missionDeliverablesDir, { recursive: true });

  const copiedArtifacts: Array<{ kind: string; path: string; description: string }> = [];
  const copyArtifact = (relativeName: string, kind: string, description: string): void => {
    const sourcePath = path.join(evidenceDir, relativeName);
    if (!safeExistsSync(sourcePath)) return;
    const destinationPath = path.join(missionDeliverablesDir, relativeName);
    safeMkdir(path.dirname(destinationPath), { recursive: true });
    safeCopyFileSync(sourcePath, destinationPath);
    copiedArtifacts.push({
      kind,
      path: path.relative(customerRoot, destinationPath),
      description,
    });
  };

  copyArtifact('minutes.md', 'minutes', 'Meeting minutes for the follow-up delivery.');
  copyArtifact(
    'action-items.jsonl',
    'action-items',
    'Structured action items captured from the meeting.'
  );
  copyArtifact(
    'meeting-followup-pack.json',
    'delivery-pack-source',
    'Pipeline-generated follow-up pack.'
  );

  if (copiedArtifacts.length === 0) {
    logger.warn(
      `⚠️ [DELIVERY] Meeting deliverables skipped for ${input.missionId}: no follow-up evidence found under ${evidenceDir}.`
    );
    input.traceCtx.addEvent('meeting_delivery.skipped', {
      reason: 'no_followup_evidence',
    });
    return;
  }

  let minutesExcerpt = '';
  const minutesPath = path.join(missionDeliverablesDir, 'minutes.md');
  if (safeExistsSync(minutesPath)) {
    const minutes = String(safeReadFile(minutesPath, { encoding: 'utf8' }));
    minutesExcerpt = minutes.split(/\r?\n/u).slice(0, 8).join('\n').trim();
  }

  const summary = [
    `Meeting follow-up delivered for ${input.missionId} to customer ${tenantSlug}.`,
    input.completionNextAction?.request || input.state.outcome_contract?.requested_result || '',
  ]
    .filter(Boolean)
    .join(' ');
  const pack = {
    kind: 'delivery-pack',
    pack_id: `${input.missionId}-meeting-delivery`,
    summary,
    request_text:
      input.completionNextAction?.request || input.state.outcome_contract?.requested_result,
    ...(minutesExcerpt ? { conversation_summary: minutesExcerpt } : {}),
    recommended_next_action: input.completionNextAction?.next_step,
    artifacts_by_role: {
      primary: [
        path.relative(customerRoot, path.join(missionDeliverablesDir, 'delivery-summary.md')),
      ],
      evidence: copiedArtifacts.map((artifact) => artifact.path),
    },
    artifacts: copiedArtifacts.map((artifact, index) => ({
      id: `${input.missionId}-${index + 1}`,
      kind: artifact.kind,
      path: artifact.path,
      description: artifact.description,
    })),
  };

  safeWriteFile(
    path.join(missionDeliverablesDir, 'delivery-summary.md'),
    [
      `# Meeting Delivery Summary`,
      ``,
      `- Mission: ${input.missionId}`,
      `- Tenant: ${tenantSlug}`,
      `- Summary: ${summary}`,
      `- Deliverables:`,
      ...copiedArtifacts.map((artifact) => `  - ${artifact.path} (${artifact.kind})`),
    ].join('\n')
  );
  safeWriteFile(
    path.join(missionDeliverablesDir, 'delivery-pack.json'),
    JSON.stringify(pack, null, 2)
  );

  const deliveryLogPath = path.join(deliverablesRoot, 'delivery-log.jsonl');
  safeAppendFileSync(
    deliveryLogPath,
    `${JSON.stringify({
      mission_id: input.missionId,
      tenant_slug: tenantSlug,
      delivered_at: new Date().toISOString(),
      deliverable_dir: path.relative(pathResolver.rootDir(), missionDeliverablesDir),
      artifacts: copiedArtifacts.map((artifact) => artifact.path),
      summary,
    })}\n`
  );

  input.traceCtx.addEvent('meeting_delivery.published', {
    artifact_count: copiedArtifacts.length,
  });
  logger.info(
    `📦 [DELIVERY] Published meeting deliverables for ${input.missionId} to ${path.relative(
      pathResolver.rootDir(),
      missionDeliverablesDir
    )}.`
  );
}

function sidecarPathForMarkdown(mdPath: string): string {
  return mdPath.endsWith('.md')
    ? mdPath.slice(0, -3) + '.volatile.json'
    : `${mdPath}.volatile.json`;
}

function extractPromotableMissionMemory(raw: string): string | null {
  const lines = raw.split(/\r?\n/u);
  const collected: string[] = [];
  let capturing = false;

  for (const line of lines) {
    if (/^##\s+(Decisions|Lessons Learned)\s*$/iu.test(line.trim())) {
      capturing = true;
      continue;
    }
    if (capturing && /^##\s+/u.test(line.trim())) {
      capturing = false;
    }
    if (capturing && line.trim() && !/^<!--.*-->$/u.test(line.trim())) {
      collected.push(line.trim());
    }
  }

  const summary = collected.join('\n').trim();
  return summary ? summary.slice(0, 1200) : null;
}

function updateMissionMemorySidecar(mdPath: string, candidateId: string): void {
  const sidecarPath = sidecarPathForMarkdown(mdPath);
  if (!safeExistsSync(sidecarPath)) return;
  const sidecar = JSON.parse(safeReadFile(sidecarPath, { encoding: 'utf8' }) as string) as Record<
    string,
    unknown
  >;
  safeWriteFile(
    sidecarPath,
    JSON.stringify(
      {
        ...sidecar,
        promotion_candidate_id: candidateId,
        status: 'promoted',
        updated_at: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

function readMissionNextTasks(missionDir: string): Array<Record<string, unknown>> {
  const nextTasksPath = path.join(missionDir, 'NEXT_TASKS.json');
  if (!safeExistsSync(nextTasksPath)) return [];
  try {
    const parsed = JSON.parse(
      safeReadFile(nextTasksPath, { encoding: 'utf8' }) as string
    ) as unknown;
    return Array.isArray(parsed)
      ? (parsed.filter((entry) => entry && typeof entry === 'object') as Array<
          Record<string, unknown>
        >)
      : [];
  } catch {
    return [];
  }
}

function writeMissionNextTasks(missionDir: string, tasks: Array<Record<string, unknown>>): void {
  const nextTasksPath = path.join(missionDir, 'NEXT_TASKS.json');
  safeWriteFile(nextTasksPath, JSON.stringify(tasks, null, 2));
}

function upsertMissionGateRepairTask(input: {
  missionDir: string;
  gateId: string;
  reason: string;
  pendingTasks: string[];
}): string[] {
  const tasks = readMissionNextTasks(input.missionDir);
  const repairTaskId = `repair-${input.gateId}`;
  const repairTask = {
    task_id: repairTaskId,
    status: 'planned',
    assigned_to: {
      role: 'operator',
      agent_id: 'mission_controller',
    },
    description: `Repair mission ${input.gateId} gate failure: ${input.reason}`,
    deliverable: `evidence/${repairTaskId}.md`,
    target_path: `evidence/${repairTaskId}.md`,
    dependencies: input.pendingTasks,
    acceptance_criteria: [
      `Resolve ${input.gateId} gate issue: ${input.reason}`,
      'Update mission evidence and task board to reflect the repaired gate state.',
    ],
    risk: 'medium',
    expected_output_format: 'files',
    estimated_scope: 'M',
  };
  const filtered = tasks.filter((task) => String(task.task_id || '') !== repairTaskId);
  filtered.unshift(repairTask as Record<string, unknown>);
  writeMissionNextTasks(input.missionDir, filtered);
  return [repairTaskId];
}

function evaluateMissionFinishExitGate(missionDir: string): {
  ok: boolean;
  reason?: string;
  pendingTasks: string[];
} {
  const nextTasks = readMissionNextTasks(missionDir);
  const pendingTasks = nextTasks
    .filter((task) => {
      const status = String(task.status || 'planned').toLowerCase();
      return !['done', 'completed', 'accepted', 'reviewed'].includes(status);
    })
    .map((task) => String(task.task_id || task.description || 'unknown-task'));

  if (pendingTasks.length > 0) {
    return {
      ok: false,
      reason: `Pending tasks remain: ${pendingTasks.join(', ')}`,
      pendingTasks,
    };
  }

  return { ok: true, pendingTasks: [] };
}

function recordMissionFinishGateFailure(input: {
  missionId: string;
  state: any;
  missionDir: string;
  gateId: string;
  reason: string;
  agentRuntimeEventPath: string;
  pendingTasks: string[];
}): string {
  const now = new Date().toISOString();
  const context = input.state.context || {};
  const failureCount = Number(context.mission_finish_gate_failure_count || 0) + 1;
  const shouldRealign = failureCount >= 2 && input.state.status === 'validating';
  const nextStatus = shouldRealign ? 'active' : 'validating';

  input.state.context = {
    ...context,
    mission_finish_gate_failure_count: failureCount,
    mission_finish_gate_last_reason: input.reason,
    mission_finish_gate_last_checked_at: now,
  };
  const repairTaskIds = upsertMissionGateRepairTask({
    missionDir: input.missionDir,
    gateId: input.gateId,
    reason: input.reason,
    pendingTasks: input.pendingTasks,
  });
  input.state.status = nextStatus;
  input.state.history.push({
    ts: now,
    event: shouldRealign ? 'REALIGN' : 'EXIT_GATE_FAIL',
    note: shouldRealign
      ? `Finish gate failed ${failureCount} times; realigning to active. Reason: ${input.reason}`
      : `Finish gate failed. Reason: ${input.reason}`,
  });
  recordAgentRuntimeEvent(input.agentRuntimeEventPath, {
    event: shouldRealign ? 'MISSION_REALIGN_REQUESTED' : 'MISSION_FINISH_GATE_FAILED',
    mission_id: input.missionId,
    gate_id: input.gateId,
    failure_count: failureCount,
    reason: input.reason,
    next_status: input.state.status,
    repair_task_ids: repairTaskIds,
  });
  void notifyOperator('mission_failed', {
    title: `Mission ${input.missionId} blocked at ${input.gateId}`,
    body: input.reason,
    link_hint: `pnpm mission status ${input.missionId}`,
    correlation_id: `${input.missionId}:${input.gateId}`,
  });
  const gatePath = recordMissionGateOverride({
    missionId: input.missionId,
    gateId: input.gateId,
    outcome: 'rejected',
    note: input.reason,
    actorId: 'mission_controller',
    evidenceDir: path.join(input.missionDir, 'gates'),
  });
  input.state.context = {
    ...(input.state.context || {}),
    mission_finish_gate_last_path: gatePath,
  };
  return gatePath;
}

function recordMissionIntentDriftGateFailure(input: {
  missionId: string;
  state: any;
  missionDir: string;
  reason: string;
  agentRuntimeEventPath: string;
}): string {
  const now = new Date().toISOString();
  const context = input.state.context || {};
  const failureCount = Number(context.intent_drift_gate_failure_count || 0) + 1;
  const nextStatus =
    input.state.status === 'active' || input.state.status === 'validating'
      ? 'validating'
      : input.state.status;

  input.state.context = {
    ...context,
    intent_drift_gate_failure_count: failureCount,
    intent_drift_gate_last_reason: input.reason,
    intent_drift_gate_last_checked_at: now,
  };
  const repairTaskIds = upsertMissionGateRepairTask({
    missionDir: input.missionDir,
    gateId: 'intent-drift',
    reason: input.reason,
    pendingTasks: [],
  });
  input.state.status = nextStatus;
  input.state.history.push({
    ts: now,
    event: 'REALIGN',
    note: `Intent drift detected; realigning mission. Reason: ${input.reason}`,
  });
  recordAgentRuntimeEvent(input.agentRuntimeEventPath, {
    event: 'MISSION_INTENT_DRIFT_BLOCKED',
    mission_id: input.missionId,
    gate_id: 'intent-drift',
    failure_count: failureCount,
    reason: input.reason,
    next_status: input.state.status,
    repair_task_ids: repairTaskIds,
  });
  const gatePath = recordMissionGateOverride({
    missionId: input.missionId,
    gateId: 'intent-drift',
    outcome: 'rejected',
    note: input.reason,
    actorId: 'mission_controller',
    evidenceDir: path.join(input.missionDir, 'gates'),
  });
  input.state.context = {
    ...(input.state.context || {}),
    intent_drift_gate_last_path: gatePath,
  };
  return gatePath;
}

function maybeRunVolatileGc(
  upperId: string,
  traceCtx: ReturnType<typeof createActuatorTrace>
): void {
  try {
    const runnerPath = pathResolver.rootResolve('dist/scripts/run_pipeline.js');
    if (!safeExistsSync(runnerPath)) {
      logger.warn(
        `⚠️ [VOLATILE_GC] skipped for ${upperId}: dist/scripts/run_pipeline.js not found.`
      );
      traceCtx.addEvent('volatile_gc.skipped', { reason: 'runner_not_built' });
      return;
    }
    traceCtx.startSpan('mission:volatile-gc');
    safeExec(process.execPath, [runnerPath, '--input', 'pipelines/volatile-gc.json'], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 120000,
    });
    traceCtx.endSpan('ok');
  } catch (err: any) {
    logger.warn(`⚠️ [VOLATILE_GC] skipped for ${upperId}: ${err?.message || err}`);
    traceCtx.endSpan('error', err?.message || String(err));
  }
}

export async function delegateMission(
  id: string,
  agentId: string,
  a2aMessageId: string,
  syncProjectLedgerIfLinked: (missionId: string) => Promise<void>
): Promise<void> {
  if (!id || !agentId || !a2aMessageId) {
    logger.error('Usage: mission_controller delegate <MISSION_ID> <AGENT_ID> <A2A_MESSAGE_ID>');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }

  const trustLedger = readTrustLedger();
  const agent = trustLedger[agentId];
  if (
    agent &&
    agent.current_score < 300 &&
    (state.tier === 'personal' || state.tier === 'confidential')
  ) {
    throw new Error(
      `CRITICAL: Agent ${agentId} has insufficient trust score (${agent.current_score}) for ${state.tier} tier mission.`
    );
  }

  logger.info(`📤 Delegating Mission ${upperId} to agent ${agentId}...`);

  if (state.status !== 'active') state.status = 'active';
  state.execution_mode = 'delegated';
  state.delegation = {
    agent_id: agentId,
    a2a_message_id: a2aMessageId,
    last_sync_ts: new Date().toISOString(),
    verification_status: 'pending',
  };
  state.history.push({
    ts: new Date().toISOString(),
    event: 'DELEGATE',
    note: `Mission delegated to ${agentId} (A2A: ${a2aMessageId})`,
  });

  await saveState(upperId, state);
  await syncProjectLedgerIfLinked(upperId);
  logger.success(`✅ Mission ${upperId} marked as DELEGATED.`);
}

export async function importMission(
  id: string,
  remoteUrl: string,
  transitionStatus: (current: string, next: string) => any,
  syncProjectLedgerIfLinked: (missionId: string) => Promise<void>
): Promise<void> {
  if (!id || !remoteUrl) {
    logger.error('Usage: mission_controller import <MISSION_ID> <REMOTE_URL>');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }

  const missionDir = findMissionPath(upperId);
  if (!missionDir) {
    logger.error(`Mission directory for ${upperId} not found.`);
    return;
  }

  logger.info(`📥 Importing results for Mission ${upperId} from ${remoteUrl}...`);
  try {
    try {
      safeExec('git', ['remote', 'add', 'origin_remote', remoteUrl], { cwd: missionDir });
    } catch (_) {
      safeExec('git', ['remote', 'set-url', 'origin_remote', remoteUrl], { cwd: missionDir });
    }
    safeExec('git', ['fetch', 'origin_remote'], { cwd: missionDir });
    safeExec('git', ['merge', 'origin_remote/main', '--no-edit'], { cwd: missionDir });

    state.status = transitionStatus(state.status, 'validating');
    if (state.delegation) {
      state.delegation.last_sync_ts = new Date().toISOString();
      state.delegation.remote_repo_url = remoteUrl;
    }
    state.history.push({
      ts: new Date().toISOString(),
      event: 'IMPORT',
      note: `Imported results from ${remoteUrl}. Transitioned to VALIDATING.`,
    });

    await saveState(upperId, state);
    await syncProjectLedgerIfLinked(upperId);
    logger.success(`✅ Results imported for ${upperId}. Manual/Auto verification required.`);
  } catch (err: any) {
    logger.error(`Import failed: ${err.message}`);
  }
}

export async function verifyMission(
  id: string,
  result: 'verified' | 'rejected',
  note: string,
  transitionStatus: (current: string, next: string) => any,
  syncProjectLedgerIfLinked: (missionId: string) => Promise<void>
): Promise<void> {
  if (!id || !result || !['verified', 'rejected'].includes(result)) {
    logger.error('Usage: mission_controller verify <MISSION_ID> <verified|rejected> <note>');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }

  if (state.status !== 'active' && state.status !== 'validating') {
    logger.error(
      `❌ Cannot verify mission ${upperId} (status: ${state.status}). Only active or validating missions can be verified.`
    );
    return;
  }

  const missionDir = findMissionPath(upperId);
  if (!missionDir) {
    logger.error(`Mission directory for ${upperId} not found.`);
    return;
  }
  const runtimeEventPath = path.join(missionDir, 'runtime-events.jsonl');

  logger.info(`🛡️ Verifying Mission ${upperId}: Result = ${result.toUpperCase()}`);

  if (result === 'verified') {
    const driftSummary = evaluateMissionIntentDrift(upperId);
    const driftReview = summarizeReviewGateVerdicts({
      reviewMode: 'standard',
      results: [
        driftSummary
          ? {
              gate_id: 'INTENT_DRIFT',
              verdict: driftSummary.passed ? 'ready' : 'blocked',
              reason: driftSummary.message,
            }
          : {
              gate_id: 'INTENT_DRIFT',
              verdict: 'concerns',
              reason: 'Intent drift gate unavailable.',
            },
      ],
    });
    const driftGate = driftReview.gate_results[0];
    if (driftReview.overall_verdict === 'blocked') {
      logger.error(
        `❌ [INTENT_DRIFT] Mission ${upperId} blocked: ${driftGate.reason || 'drift gate blocked'}`
      );
      recordMissionIntentDriftGateFailure({
        missionId: upperId,
        state,
        missionDir,
        reason: driftGate.reason || 'intent drift gate blocked',
        agentRuntimeEventPath: runtimeEventPath,
      });
      await saveState(upperId, state);
      await syncProjectLedgerIfLinked(upperId);
      return;
    }
    state.context = {
      ...(state.context || {}),
      intent_review_summary: driftReview,
    } as any;
    writeMissionGateRecord({
      missionId: upperId,
      gateId: 'intent-drift',
      evidenceDir: path.join(missionDir, 'gates'),
      payload: {
        verdict: 'pass',
        checked_at: new Date().toISOString(),
        reason: driftGate.reason || 'intent drift gate passed',
        review_summary: driftReview,
      },
    });
    state.status = transitionStatus(state.status, 'distilling');
  } else if (state.status !== 'active') {
    state.status = transitionStatus(state.status, 'active');
  }

  if (state.delegation) {
    state.delegation.verification_status = result;
    updateTrustScore(state.delegation.agent_id, result);
  }

  state.history.push({
    ts: new Date().toISOString(),
    event: 'VERIFY',
    note: `Verification ${result}: ${note}`,
  });

  await saveState(upperId, state);
  await syncProjectLedgerIfLinked(upperId);
  await emitMissionLifecycleIntentSnapshot({
    missionId: upperId,
    stage: 'verification',
    text: note,
    source: 'mission_state',
    traceRef: state.correlation_id,
  });
  logger.success(`✅ Mission ${upperId} verification complete. Status: ${state.status}`);
}

export async function finishMission(
  id: string,
  seal: boolean,
  args: {
    archiveDir: string;
    agentRuntimeEventPath: string;
    getGitHash: (cwd: string) => string;
    sealMission: (missionId: string) => Promise<string | undefined>;
    syncProjectLedgerIfLinked: (missionId: string) => Promise<void>;
    transitionStatus: (current: string, next: string) => any;
  }
): Promise<void> {
  if (!id) {
    logger.error('Usage: mission_controller finish <MISSION_ID> [--seal]');
    return;
  }
  const upperId = id.toUpperCase();
  const preState = loadState(upperId);
  if (!preState) {
    logger.error(`❌ Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }
  if (preState.status === 'archived') {
    logger.info(`Mission ${upperId} is already archived.`);
    return;
  }
  if (
    preState.status !== 'completed' &&
    preState.status !== 'distilling' &&
    preState.status !== 'validating'
  ) {
    const steps: Record<string, string> = {
      planned: 'Run "start" to activate the mission first.',
      active: 'Run "verify" → "distill" to complete the mission lifecycle first.',
      validating: 'Re-run finish after addressing the validation gap.',
      paused: 'Run "start" to resume, then complete the lifecycle.',
      failed: 'Run "start" to retry, then complete the lifecycle.',
    };
    logger.error(
      `❌ Cannot finish mission ${upperId} (status: ${preState.status}). ${steps[preState.status] || ''}`
    );
    return;
  }

  await emitMissionLifecycleIntentSnapshot({
    missionId: upperId,
    stage: 'delivery',
    text: latestSnapshot(upperId)?.intent.goal || `Mission ${upperId} progressing through learn`,
    source: 'mission_state',
    traceRef: preState.correlation_id,
  });
  const missionDir = findMissionPath(upperId);
  if (!missionDir) return;
  const driftSummary = evaluateMissionIntentDrift(upperId);
  if (driftSummary && !driftSummary.passed) {
    logger.error(`❌ [INTENT_DRIFT] Mission ${upperId} blocked: ${driftSummary.message}`);
    const state = loadState(upperId);
    if (state) {
      recordMissionFinishGateFailure({
        missionId: upperId,
        state,
        missionDir,
        gateId: 'intent-drift',
        reason: driftSummary.message,
        agentRuntimeEventPath: args.agentRuntimeEventPath,
        pendingTasks: [],
      });
      await saveState(upperId, state);
    }
    return;
  }
  writeMissionGateRecord({
    missionId: upperId,
    gateId: 'intent-drift',
    evidenceDir: path.join(missionDir, 'gates'),
    payload: {
      verdict: 'pass',
      checked_at: new Date().toISOString(),
      reason: driftSummary?.message || 'intent drift gate passed',
    },
  });

  const exitGate = evaluateMissionFinishExitGate(missionDir);
  if (!exitGate.ok) {
    logger.error(`❌ [EXIT_GATE] Mission ${upperId} blocked: ${exitGate.reason}`);
    const state = loadState(upperId);
    if (state) {
      recordMissionFinishGateFailure({
        missionId: upperId,
        state,
        missionDir,
        gateId: 'finish-exit',
        reason: exitGate.reason || 'exit gate blocked',
        agentRuntimeEventPath: args.agentRuntimeEventPath,
        pendingTasks: exitGate.pendingTasks,
      });
      await saveState(upperId, state);
    }
    return;
  }
  writeMissionGateRecord({
    missionId: upperId,
    gateId: 'finish-exit',
    evidenceDir: path.join(missionDir, 'gates'),
    payload: {
      verdict: 'pass',
      checked_at: new Date().toISOString(),
      reason: 'No pending tasks remain',
    },
  });

  const quality = await validateMissionQuality(upperId);
  if (!quality.ok) {
    logger.error(
      `❌ [QUALITY_REJECTION] Mission ${upperId} does not meet governance requirements: ${quality.reason}`
    );
    const state = loadState(upperId);
    if (state) {
      recordMissionFinishGateFailure({
        missionId: upperId,
        state,
        missionDir,
        gateId: 'finish-quality',
        reason: quality.reason || 'quality gate blocked',
        agentRuntimeEventPath: args.agentRuntimeEventPath,
        pendingTasks: [],
      });
      await saveState(upperId, state);
    }
    return;
  }
  writeMissionGateRecord({
    missionId: upperId,
    gateId: 'finish-quality',
    evidenceDir: path.join(missionDir, 'gates'),
    payload: {
      verdict: 'pass',
      checked_at: new Date().toISOString(),
      reason: 'Mission quality validation passed',
    },
  });

  const state = loadState(upperId);
  if (!state) throw new Error(`Mission ${upperId} not found.`);
  if (driftSummary) {
    state.context = {
      ...(state.context || {}),
      intent_delta_summary: driftSummary,
    };
  }

  const evidence = collectMissionEvidence(missionDir);
  const evidenceRefs = evidence.map((item) => item.ref);
  const completionGoal = {
    summary:
      state.intent?.goal_summary ||
      state.outcome_contract?.requested_result ||
      `Mission ${upperId}`,
    success_condition:
      state.intent?.success_condition ||
      state.outcome_contract?.success_criteria?.join('; ') ||
      state.outcome_contract?.requested_result ||
      `Mission ${upperId}`,
  };
  const completionReconciliation = await reconcileCompletion({
    goal: completionGoal,
    evidenceRefs,
    requestedResult: state.outcome_contract?.requested_result,
  });
  const completionNextAction = buildCompletionNextAction({
    goal: completionGoal,
    reconciliation: completionReconciliation,
  });
  const traceCtx = createActuatorTrace('mission-controller', 'finish', {
    pipelineId: upperId,
    missionId: upperId,
  });
  traceCtx.startSpan('mission:finish', {
    evidence_count: evidence.length,
    tier: state.tier,
  });

  logger.info(`🏁 Finishing Mission: ${upperId}...`);

  try {
    traceCtx.startSpan('mission:commit');
    safeExec('git', ['add', '.'], { cwd: missionDir });
    safeExec('git', ['commit', '-m', `feat: complete mission ${upperId}`], { cwd: missionDir });
    state.git.latest_commit = args.getGitHash(missionDir);
    traceCtx.endSpan('ok');
  } catch (_) {
    logger.info('No changes to commit in mission repo.');
    traceCtx.endSpan('ok');
  }

  if (state.status !== 'completed') {
    traceCtx.startSpan('mission:complete-state');
    state.status = args.transitionStatus(state.status, 'completed');
    state.history.push({
      ts: new Date().toISOString(),
      event: 'FINISH',
      note: 'Mission completed.',
    });
    traceCtx.endSpan('ok');
  }
  traceCtx.startSpan('mission:evidence');
  for (const item of evidence) {
    traceCtx.addArtifact('file', item.ref, 'mission evidence ref');
  }
  traceCtx.endSpan('ok');
  await saveState(upperId, state);
  await args.syncProjectLedgerIfLinked(upperId);
  traceCtx.addEvent('ledger.synced', { evidence_count: evidence.length });

  // E2E-04 Tasks 2+3: deliverables land in the operator inbox and the
  // completion is pushed to the configured channel (failure-tolerant).
  try {
    if (evidenceRefs.length > 0) {
      addInboxEntry({
        missionId: upperId,
        title: completionGoal.summary,
        artifactPaths: evidenceRefs,
        summary:
          (typeof completionNextAction === 'string'
            ? completionNextAction
            : completionNextAction?.next_step) || `Mission ${upperId} completed.`,
      });
      void notifyOperator('deliverable_ready', {
        title: completionGoal.summary,
        body: `成果物 ${evidenceRefs.length} 件が inbox に届きました。`,
        link_hint: 'pnpm kyberion inbox',
        correlation_id: upperId,
      });
    }
    void notifyOperator('mission_completed', {
      title: `Mission ${upperId} completed`,
      body: completionGoal.summary,
      link_hint: `pnpm mission status ${upperId}`,
      correlation_id: upperId,
    });
  } catch (err: any) {
    logger.warn(
      `⚠️ [NOTIFY] Completion notification failed for ${upperId}: ${err?.message || err}`
    );
  }

  traceCtx.startSpan('mission:customer-delivery');
  try {
    publishMeetingDeliverablesIfNeeded({
      missionId: upperId,
      missionDir,
      state,
      completionNextAction,
      traceCtx,
    });
    traceCtx.endSpan('ok');
  } catch (err: any) {
    logger.warn(`⚠️ [DELIVERY] Meeting deliverables failed for ${upperId}: ${err?.message || err}`);
    traceCtx.endSpan('error', err?.message || String(err));
  }

  if (seal || (state.tier === 'personal' && process.env.AUTO_SEAL === 'true')) {
    traceCtx.startSpan('mission:seal');
    await args.sealMission(upperId);
    traceCtx.endSpan('ok');
  }

  try {
    traceCtx.startSpan('mission:memory-promotion');
    const memoryPath = path.join(
      pathResolver.volatile('mission', upperId, { tier: state.tier }),
      'MEMORY.md'
    );
    const memorySummary = safeExistsSync(memoryPath)
      ? extractPromotableMissionMemory(safeReadFile(memoryPath, { encoding: 'utf8' }) as string)
      : null;
    const memoryEvidenceRefs = memorySummary
      ? [...evidence.map((item) => item.ref), memoryPath]
      : evidence.map((item) => item.ref);
    const queued = queueMissionMemoryPromotionCandidate({
      missionId: upperId,
      missionType: state.mission_type,
      tier: state.tier,
      summary:
        memorySummary ||
        state.outcome_contract?.requested_result ||
        `Mission ${upperId} completed and yielded reusable operational memory.`,
      evidenceRefs: memoryEvidenceRefs,
    });
    if (memorySummary) updateMissionMemorySidecar(memoryPath, queued.candidate_id);
    logger.info(
      `🧠 [MEMORY_PROMOTION] queued candidate ${queued.candidate_id} (${queued.proposed_memory_kind}).`
    );
    traceCtx.endSpan('ok');
  } catch (err: any) {
    logger.warn(`⚠️ [MEMORY_PROMOTION] queue skipped for ${upperId}: ${err?.message || err}`);
    traceCtx.endSpan('error', err?.message || String(err));
  }

  maybeRunVolatileGc(upperId, traceCtx);

  if (!ledger.verifyIntegrity()) {
    logger.warn(
      `⚠️ [LEDGER_INTEGRITY] Global ledger integrity check failed for mission ${upperId}. The ledger may be corrupted — review ${upperId} audit trail before relying on it.`
    );
    traceCtx.addEvent('ledger.integrity_failed');
  }

  traceCtx.startSpan('mission:ledger-record');
  ledger.record('MISSION_FINISH', {
    mission_id: upperId,
    status: 'completed',
    sealed: seal,
    archive_path: args.archiveDir,
  });
  traceCtx.endSpan('ok');

  recordAgentRuntimeEvent(args.agentRuntimeEventPath, {
    event: 'MISSION_FINISH_REFRESH_RECOMMENDED',
    mission_id: upperId,
    tier: state.tier,
    note: 'Mission finished. Control surfaces may refresh or restart mission-bound agents to reduce stale context.',
  });

  const missionTmpDir = pathResolver.sharedTmp(path.join('missions', upperId));
  if (safeExistsSync(missionTmpDir)) {
    traceCtx.startSpan('mission:purge-temp');
    logger.info('🧹 Purging mission runtime temp...');
    safeRmSync(missionTmpDir, { recursive: true, force: true });
    traceCtx.endSpan('ok');
  }

  if (!safeExistsSync(args.archiveDir)) safeMkdir(args.archiveDir, { recursive: true });
  const archivePath = path.join(args.archiveDir, upperId);
  traceCtx.startSpan('mission:archive');
  if (safeExistsSync(archivePath)) safeExec('rm', ['-rf', archivePath]);
  safeExec('cp', ['-r', missionDir, archivePath]);
  safeExec('rm', ['-rf', missionDir]);
  traceCtx.endSpan('ok');

  state.status = args.transitionStatus(state.status, 'archived');
  state.history.push({
    ts: new Date().toISOString(),
    event: 'ARCHIVE',
    note: `Mission archived to ${archivePath}.`,
  });
  await saveState(upperId, state);
  traceCtx.endSpan('ok');
  const traceResult = finalizeActuatorTrace(traceCtx);
  state.context = {
    ...(state.context || {}),
    mission_completion_next_action: completionNextAction,
    mission_completion_summary: {
      requested_result: completionNextAction.request,
      satisfied: completionNextAction.satisfied,
      delivered: completionNextAction.delivered,
      gaps: completionNextAction.gaps,
      next_step: completionNextAction.next_step,
      confidence: completionNextAction.confidence,
    },
    mission_completion_reconciliation: completionReconciliation,
    mission_finish_trace_summary: traceResult.trace_summary,
    mission_finish_trace_persisted_path: traceResult.trace_persisted_path,
  };
  await saveState(upperId, state);
  logger.success(`📦 Mission ${upperId} archived and finalized.`);
}

export async function pauseMission(id: string, note?: string): Promise<void> {
  if (!id) {
    logger.error('Usage: mission_controller pause <MISSION_ID> [--note "..."]');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found.`);
    return;
  }
  if (state.status === 'completed' || state.status === 'archived') {
    logger.info(`Mission ${upperId} is already ${state.status}.`);
    return;
  }
  if (state.status === 'paused') {
    logger.info(`Mission ${upperId} is already paused.`);
    return;
  }

  state.status = 'paused';
  state.context = {
    ...(state.context || {}),
    next_step: 'Resume the mission when the operator is ready.',
  };
  state.history.push({
    ts: new Date().toISOString(),
    event: 'PAUSE',
    note: note || 'Mission paused by operator request.',
  });
  await saveState(upperId, state);
  recordAgentRuntimeEvent(
    pathResolver.shared('observability/mission-control/agent-runtime-events.jsonl'),
    {
      event: 'MISSION_PAUSED',
      mission_id: upperId,
      note: note || 'Mission paused by operator request.',
    }
  );
  logger.warn(`⏸️ Mission ${upperId} paused.`);
}

export async function cancelMission(id: string, note?: string): Promise<void> {
  if (!id) {
    logger.error('Usage: mission_controller cancel <MISSION_ID> [--note "..."]');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found.`);
    return;
  }
  if (state.status === 'completed' || state.status === 'archived') {
    logger.info(`Mission ${upperId} is already ${state.status}.`);
    return;
  }

  state.status = 'failed';
  state.context = {
    ...(state.context || {}),
    cancelled: true,
    cancel_reason: note || 'Mission cancelled by operator request.',
    next_step: 'Create a replacement mission if the work should continue.',
  };
  state.history.push({
    ts: new Date().toISOString(),
    event: 'CANCEL',
    note: note || 'Mission cancelled by operator request.',
  });
  await saveState(upperId, state);
  recordAgentRuntimeEvent(
    pathResolver.shared('observability/mission-control/agent-runtime-events.jsonl'),
    {
      event: 'MISSION_CANCELLED',
      mission_id: upperId,
      note: note || 'Mission cancelled by operator request.',
    }
  );
  logger.warn(`🛑 Mission ${upperId} cancelled.`);
}

export async function grantMissionAccess(
  missionId: string,
  serviceId: string,
  ttl = 30
): Promise<void> {
  const upperId = missionId.toUpperCase();
  const state = loadState(upperId);
  if (!state) throw new Error(`Mission ${upperId} not found.`);
  grantAccess(upperId, serviceId, ttl);
  logger.success(`🔑 Access to "${serviceId}" granted to mission ${upperId} for ${ttl} minutes.`);
}

export async function grantMissionSudo(missionId: string, on = true, ttl = 15): Promise<void> {
  const upperId = missionId.toUpperCase();
  const state = loadState(upperId);
  if (!state) throw new Error(`Mission ${upperId} not found.`);
  if (on) {
    // Authority grants pass through the approval gate (auth:grant_authority).
    // Without an approved request on file this call throws, protecting against
    // unilateral SUDO escalation by agents.
    await grantAccessGuarded(upperId, 'SUDO', ttl, true, {
      agentId: 'mission_controller',
      correlationId: `${upperId}:SUDO`,
    });
    logger.warn(
      `⚠️ [SUDO] Full system authority granted to mission ${upperId} for ${ttl} minutes!`
    );
  } else {
    logger.info(
      '[SUDO] Sudo will expire naturally or can be revoked by clearing auth-grants.json.'
    );
  }
}
