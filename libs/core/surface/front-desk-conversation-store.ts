import {
  conversationRef,
  asStore,
  validText,
  load,
  publishTranscript,
  frontDeskRuntimeScope,
  readFrontDeskExecutionRecovery,
  inspectFrontDeskPendingRequest,
  PENDING_RETENTION_MS,
  MAX_DROPPED_REQUESTS,
  CONVERSATION_RETRY_WINDOW_MS,
  type Turn,
  type Transcript,
  type FrontDeskConversationViewer,
  type ReservedConversationTurn,
  type FrontDeskExecutionRequest,
  type FrontDeskExecutionReport,
} from './front-desk-conversation-persistence.js';
export {
  conversationRef,
  frontDeskConversationScope,
  frontDeskRuntimeScope,
  readFrontDeskExecutionRecovery,
  presenceFrontDeskConversationViewer,
  CONVERSATION_RETRY_WINDOW_MS,
  type FrontDeskConversationViewer,
  type ReservedConversationTurn,
  type FrontDeskExecutionRequest,
  type FrontDeskExecutionReport,
} from './front-desk-conversation-persistence.js';
import { isFirstJobDiagnosticMapping } from './first-job-admission.js';
import { frontDeskExecutionProposal } from './front-desk-execution-proposal.js';
import { frontDeskExecutionArtifactPath } from './front-desk-execution-artifact.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  loadFrontDeskExecutionPolicy,
  FIRST_JOB_DIAGNOSTIC_PROTOCOL,
  frontDeskMappingDigest,
  getFrontDeskExecutionMapping,
  frontDeskExecutionViewerMatches,
  isFrontDeskExecutionPublicViewer,
  frontDeskExecutionExpectedContent,
  parseFrontDeskArtifactRevisionInput,
  frontDeskArtifactRevisionCommand,
  frontDeskArtifactRevisionDigest,
  type FrontDeskArtifactRevisionInput,
  type FrontDeskExecutionBinding,
  type FrontDeskExecutionMapping,
  type FrontDeskExecutionProjection,
} from './front-desk-execution-contract.js';
import { projectFrontDeskExecution } from './front-desk-execution-status.js';
import {
  getWorkItem,
  assertUndispatchedWorkItemEvidenceHeld,
  readUndispatchedWorkItemEvidence,
} from '../workforce/work-coordination.js';
import { assertFrontDeskDispatchLockHeld } from './front-desk-dispatch-lock.js';
import { assertFrontDeskRecoveryOutputsAbsent } from './front-desk-recovery-evidence.js';
import { findDotCharter } from '../dot/dot-charter.js';
import { firstJobApprovalEffect } from './first-job-approval-proof.js';
import { loadApprovalRequest, computeApprovalPayloadHash } from '../governance/approval-store.js';
import {
  readDotActionLedgerStrict,
  dotActionRecordHash,
  dotProposalHash,
} from '../dot/dot-action-ledger.js';
import {
  parseFrontDeskExecutionRecoveryReceipt,
  recoveryEvidenceHash,
  sameRecoveryReceipt,
  type FrontDeskExecutionRecoveryReceipt,
} from './front-desk-recovery-receipt.js';
export type { FrontDeskExecutionRecoveryReceipt } from './front-desk-recovery-receipt.js';
import { withLockSync } from '../lock-utils.js';
import { redactSensitiveString } from '../network.js';
import { narrowSurfaceViewerScope } from './surface-mutation-guard.js';
import type { SupportedLocale } from '../locale-normalize.js';
import { t } from '../t.js';
import {
  applyConversationTurnOutcome,
  routeConversationTaskTurn,
  parseConversationTaskState,
  parseConversationTaskDecision,
  CONVERSATION_TASK_MAX_TASKS,
  CONVERSATION_TASK_MAX_TITLE,
  CONVERSATION_TASK_MAX_EXCERPT,
  type ConversationTaskState,
  type ConversationTaskDecision,
  type ConversationTurnOutcome,
} from './conversation-task-routing.js';
export {
  classifyConversationTurnOutcome,
  type ConversationTurnOutcome,
} from './conversation-task-routing.js';

import {
  CONVERSATION_MAX_INPUT,
  CONVERSATION_MAX_REPLY,
  CONVERSATION_MAX_TURNS,
  type ConversationHistory,
  type ConversationHistoryMessage,
  type FrontDeskConversationWork,
  type FrontDeskConversationWorkTask,
  type FrontDeskConversationWorkArtifact,
  ConversationStoreError,
} from './front-desk-conversation-history.js';
export {
  ConversationStoreError,
  type FrontDeskConversationWork,
  type FrontDeskConversationWorkTask,
  type FrontDeskConversationWorkArtifact,
} from './front-desk-conversation-history.js';

/** Known/registered credentials are redacted; arbitrary passwords cannot be inferred. */
function storedText(text: string, limit: number): string {
  return (
    redactSensitiveString(text)
      .replace(
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
        '[REDACTED_SECRET]'
      )
      .replace(
        /\b(password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
        '$1=[REDACTED_SECRET]'
      )
      // Redaction can expand short credentials. Bound the persisted projection,
      // after every secret has been removed, so it remains readable by load().
      .slice(0, limit)
  );
}

/**
 * Legacy callers retain durable report synchronization. HTTP display/resume
 * reads opt into a fresh in-memory snapshot without locks or publications.
 */
export function readConversationHistory(
  viewer: FrontDeskConversationViewer,
  options: { readOnly?: boolean } = {}
): ConversationHistory {
  const ref = conversationRef(viewer);
  return asStore(viewer, () => {
    const read = () => {
      const transcript = load(ref);
      if (!options.readOnly && syncExecutionReports(viewer, transcript))
        publishTranscript(ref, transcript);
      return projectConversationHistory(viewer, transcript, options.readOnly === true);
    };
    return options.readOnly ? read() : withLockSync(`concierge-history-${ref.key}`, read);
  });
}

/** Status-only copy never forwards an internal artifact path or executor error. */
function readOnlyExecutionHistoryText(projection?: FrontDeskExecutionProjection): string {
  switch (projection?.status) {
    case 'terminated_unstarted':
      return t('front_desk:execution_terminated_unstarted');
    case 'queued':
      return t('front_desk:execution_queued');
    case 'awaiting_approval':
      return t('front_desk:execution_awaiting_approval');
    case 'running':
      return t('front_desk:execution_running');
    case 'blocked':
      return t('front_desk:execution_blocked', { reason: '' }).trim();
    case 'cancel_requested':
      return t('front_desk:execution_cancel_requested');
    case 'work_completed':
      if (projection.artifactPath && /^[a-f0-9]{64}$/.test(projection.artifactSha256 ?? ''))
        return t('front_desk:work_home_status_work_completed');
      return t('front_desk:execution_unverified');
    default:
      return t('front_desk:execution_unverified');
  }
}

function projectConversationHistory(
  viewer: FrontDeskConversationViewer,
  transcript: Transcript,
  freshReports: boolean
): ConversationHistory {
  const liveProjections = new Map<string, FrontDeskExecutionProjection | undefined>();
  if (freshReports) {
    for (const request of transcript.executionRequests ?? [])
      liveProjections.set(request.binding.request_id, executionProjection(viewer, request));
  }
  const replyText = (turn: Turn): string => {
    const requestId = turn.routing?.kind === 'status' ? turn.routing.taskIds[0] : undefined;
    // Earlier status-question replies persisted the same execution text as the
    // reports. Project those too, rather than resurfacing paths or stale success.
    return requestId && liveProjections.has(requestId)
      ? readOnlyExecutionHistoryText(liveProjections.get(requestId))
      : (turn.reply ?? '');
  };
  const messages: ConversationHistoryMessage[] = transcript.turns.flatMap((turn) => [
    {
      id: `${turn.id}-user`,
      role: 'user' as const,
      createdAt: turn.createdAt,
      text: storedText(turn.text, CONVERSATION_MAX_INPUT),
    },
    ...(turn.reply === undefined
      ? []
      : [
          {
            id: `${turn.id}-secretary`,
            role: 'secretary' as const,
            createdAt: turn.createdAt,
            text: storedText(replyText(turn), CONVERSATION_MAX_REPLY),
          },
        ]),
  ]);
  // Read-only history never inherits a persisted success claim. Missing or
  // revoked execution evidence becomes an explicitly unverified message, and
  // orphaned reports have no current request from which to establish authority.
  const reports = freshReports
    ? (transcript.executionRequests ?? []).map((request) => {
        const projection = liveProjections.get(request.binding.request_id);
        const previous = transcript.executionReports?.find(
          (report) => report.requestId === request.binding.request_id
        );
        const report: FrontDeskExecutionReport = {
          id: projection?.reportId ?? 'front-desk-status-' + request.binding.request_id,
          requestId: request.binding.request_id,
          status: projection?.status ?? 'uncertain',
          text: readOnlyExecutionHistoryText(projection),
          // Anchor display ordering to a durable record, not a fabricated
          // execution completion time on each refresh.
          createdAt: previous?.createdAt ?? request.createdAt,
        };
        return { report, request, projection };
      })
    : (transcript.executionReports ?? []).map((report) => {
        const request = transcript.executionRequests?.find(
          (entry) => entry.binding.request_id === report.requestId
        );
        return {
          report,
          request,
          projection: request ? executionProjection(viewer, request) : undefined,
        };
      });
  for (const { report, request, projection } of reports) {
    const binding = request?.binding;
    const artifact =
      binding &&
      projection?.status === 'work_completed' &&
      projection.artifactSha256 &&
      (!freshReports ||
        (projection.artifactPath && /^[a-f0-9]{64}$/.test(projection.artifactSha256)))
        ? {
            requestId: binding.request_id,
            revision: binding.revision,
            sha256: projection.artifactSha256,
            format: binding.receipt_format ?? ('readable' as const),
            canRevise:
              (transcript.taskState?.tasks.length ?? 0) < CONVERSATION_TASK_MAX_TASKS &&
              binding.revision < CONVERSATION_TASK_MAX_TASKS &&
              !(transcript.executionRequests ?? []).some(
                (entry) =>
                  entry.binding.parent_request_id === binding.request_id &&
                  !verifiedTerminalRecovery(entry)
              ),
          }
        : undefined;
    messages.push({
      id: report.id,
      role: 'secretary',
      createdAt: report.createdAt,
      text: storedText(report.text, CONVERSATION_MAX_REPLY),
      ...(artifact ? { artifact } : {}),
    });
  }
  messages.sort((a, b) => a.createdAt - b.createdAt);
  return {
    sessionId: transcript.sessionId,
    pending: transcript.turns.filter((turn) => turn.reply === undefined && !turn.retryable).length,
    messages: messages.slice(-CONVERSATION_MAX_TURNS * 2),
  };
}

/** The reserved binding is not proof that an executor created a WorkItem. */
function existingExecutionWorkItemId(
  viewer: FrontDeskConversationViewer,
  request: FrontDeskExecutionRequest
): string | undefined {
  try {
    const binding = request.binding;
    const mapping = getFrontDeskExecutionMapping(binding);
    if (!mapping || !frontDeskExecutionViewerMatches(viewer, mapping)) return undefined;
    const item = getWorkItem(binding.work_item_id);
    const bound = item?.metadata?.front_desk_execution as FrontDeskExecutionBinding | undefined;
    if (
      !item ||
      !bound ||
      item.item_id !== binding.work_item_id ||
      (Object.keys(binding) as Array<keyof FrontDeskExecutionBinding>).some(
        (key) => binding[key] !== bound[key]
      )
    )
      return undefined;
    const scope = frontDeskRuntimeScope(viewer);
    if (
      item.context?.tenant_slug !== scope.tenant_slug ||
      item.context?.organization_id !== scope.organization_id ||
      item.context?.project_id !== (scope.project_id ?? 'default')
    )
      return undefined;
    return item.item_id;
  } catch {
    return undefined;
  }
}

/**
 * Load precisely this server-owned viewer key. This read does not acquire a
 * mutation lock, enumerate configured conversation partitions, sync reports,
 * publish a transcript, dispatch work, or restore approval. Atomic transcript
 * publication supplies a bounded snapshot; execution is freshly projected.
 */
export function readFrontDeskConversationWork(
  viewer: FrontDeskConversationViewer,
  locale?: SupportedLocale
): FrontDeskConversationWork {
  const { artifactBody: _body, ...work } = readConversationWorkProjection(viewer, locale);
  return work;
}

export function readFrontDeskConversationArtifact(
  viewer: FrontDeskConversationViewer,
  selector: { request_id: string; revision: number; sha256: string }
): (FrontDeskConversationWorkArtifact & { body: string }) | undefined {
  const work = readConversationWorkProjection(viewer, undefined, selector);
  const artifact = work.tasks.find((task) => task.id === selector.request_id)?.artifact;
  if (
    !artifact ||
    artifact.revision !== selector.revision ||
    artifact.sha256 !== selector.sha256 ||
    artifact.verification !== 'verified' ||
    typeof work.artifactBody !== 'string'
  )
    return undefined;
  return { ...artifact, body: work.artifactBody };
}

function readConversationWorkProjection(
  viewer: FrontDeskConversationViewer,
  locale?: SupportedLocale,
  selector?: { request_id: string; revision: number; sha256: string }
): FrontDeskConversationWork & { artifactBody?: string } {
  const ref = conversationRef(viewer);
  return asStore(viewer, () => {
    const transcript = load(ref);
    const requests = new Map(
      (transcript.executionRequests ?? []).map((request) => [request.binding.request_id, request])
    );
    let artifactBody: string | undefined;
    const tasks: FrontDeskConversationWorkTask[] = (transcript.taskState?.tasks ?? []).map(
      (task) => {
        const turns = transcript.turns.filter((turn) => turn.routing?.taskIds.includes(task.id));
        const workTurns = turns.filter(
          (turn) => turn.routing?.kind === 'new_request' || turn.routing?.kind === 'followup'
        );
        const incomplete = workTurns.filter((turn) => turn.reply === undefined);
        const turnState: FrontDeskConversationWorkTask['turnState'] = incomplete.some(
          (turn) => turn.uncertain
        )
          ? 'uncertain'
          : incomplete.some((turn) => !turn.retryable)
            ? 'pending'
            : incomplete.length > 0
              ? 'not_started'
              : workTurns.length > 0 || task.result
                ? 'settled'
                : 'unknown';
        const request = requests.get(task.id);
        // Persisted report text may describe a receipt that has since vanished.
        // Its timestamp is a recorded event only; its success is never reused.
        const reports = (transcript.executionReports ?? []).filter(
          (report) => report.requestId === task.id
        );
        const row: FrontDeskConversationWorkTask = {
          id: task.id,
          title: storedText(task.title, CONVERSATION_TASK_MAX_TITLE),
          sourceStatus: task.state === 'completed' ? 'answered' : task.state,
          createdAt: task.createdAt,
          lastRecordedAt: Math.max(
            task.createdAt,
            task.result?.at ?? 0,
            request?.createdAt ?? 0,
            ...turns.map((turn) => turn.createdAt),
            ...reports.map((report) => report.createdAt)
          ),
          turnState,
          ...(!request && task.result
            ? { resultExcerpt: storedText(task.result.excerpt, CONVERSATION_TASK_MAX_EXCERPT) }
            : {}),
        };
        if (!request) return row;
        const selected =
          selector?.request_id === request.binding.request_id &&
          selector.revision === request.binding.revision;
        const projection = executionProjection(viewer, request, locale, undefined, selected);
        const verified =
          projection?.status === 'work_completed' &&
          typeof projection.artifactSha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(projection.artifactSha256) &&
          Boolean(projection.artifactPath);
        row.executionStatus =
          projection?.status === 'work_completed' && !verified
            ? 'uncertain'
            : (projection?.status ?? 'unknown');
        if (row.executionStatus === 'terminated_unstarted') {
          row.turnState = 'settled';
          row.lastRecordedAt = Math.max(
            row.lastRecordedAt,
            Date.parse(request.recoveryReceipt!.terminated_at)
          );
          return row; // Termination produces no artifact and no pending artifact fiction.
        }
        const workItemId = existingExecutionWorkItemId(viewer, request);
        if (workItemId) row.workItemId = workItemId;
        const pending = ['queued', 'awaiting_approval', 'running'].includes(row.executionStatus);
        const binding = request.binding;
        row.artifact = {
          requestId: binding.request_id,
          revision: binding.revision,
          format: binding.receipt_format ?? 'readable',
          ...(binding.parent_request_id
            ? {
                parentRequestId: binding.parent_request_id,
                parentRevision: binding.parent_revision,
                changeReason: 'format_change' as const,
              }
            : {}),
          verification: verified ? 'verified' : pending ? 'pending' : 'unknown',
          currentness: verified
            ? 'latest_verified'
            : pending
              ? 'requested_pending'
              : 'requested_unknown',
        };
        if (verified && selected && projection?.artifactSha256 === selector?.sha256)
          artifactBody = projection?.artifactBody;
        if (verified) {
          row.verifiedAt = Date.now();
          row.artifact.sha256 = projection!.artifactSha256;
          row.artifact.verifiedAt = row.verifiedAt;
        }
        // Deliberately omit projection.text: success and failure summaries may
        // contain internal artifact paths. The adapter localizes typed statuses.
        return row;
      }
    );
    const byId = new Map(tasks.map((task) => [task.id, task]));
    for (const task of tasks) {
      if (task.artifact?.verification !== 'verified') continue;
      let child = requests.get(task.id);
      const visited = new Set<string>([task.id]);
      while (child?.binding.parent_request_id) {
        const parentId = child.binding.parent_request_id;
        const parent = requests.get(parentId);
        if (
          !parent ||
          visited.has(parentId) ||
          parent.binding.revision !== child.binding.parent_revision ||
          parent.binding.config_digest !== child.binding.config_digest ||
          parent.binding.mapping_id !== child.binding.mapping_id
        )
          break;
        visited.add(parentId);
        const artifact = byId.get(parentId)?.artifact;
        if (artifact?.verification === 'verified') artifact.currentness = 'older_verified';
        child = parent;
      }
    }
    return {
      sessionId: ref.sessionId,
      tasks,
      ...(artifactBody !== undefined ? { artifactBody } : {}),
    };
  });
}

export function beginConversationTurn(viewer: FrontDeskConversationViewer, text: string): string {
  return reserveConversationTurn(viewer, text).id;
}

/** Atomically reserve before execution. Retries only read their existing turn.
 * Keeping request IDs inside the server-owned transcript prevents cross-owner replay. */
export function reserveConversationTurn(
  viewer: FrontDeskConversationViewer,
  text: string,
  requestId: string = randomUUID(),
  requestCreatedAt = Date.now(),
  locale?: SupportedLocale,
  artifactRevision?: FrontDeskArtifactRevisionInput,
  options: { requireDiagnosticAdmission?: boolean } = {}
): ReservedConversationTurn {
  const revisionInput =
    artifactRevision === undefined
      ? undefined
      : parseFrontDeskArtifactRevisionInput(artifactRevision);
  if (
    artifactRevision !== undefined &&
    (!revisionInput || text !== frontDeskArtifactRevisionCommand(revisionInput.format))
  )
    throw new ConversationStoreError('invalid_revision');
  const turnDigest = createHash('sha256')
    .update(revisionInput ? JSON.stringify({ text, artifactRevision: revisionInput }) : text)
    .digest('hex');
  if (
    !Number.isFinite(requestCreatedAt) ||
    requestCreatedAt > Date.now() + 60_000 ||
    Date.now() - requestCreatedAt >= CONVERSATION_RETRY_WINDOW_MS
  )
    throw new ConversationStoreError('request_expired');
  // New reservations must satisfy both transcript and executable-binding identity contracts.
  // The loader deliberately retains its older permissive ID check for inert legacy history.
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId))
    throw new ConversationStoreError('invalid_text');
  if (!validText(text, CONVERSATION_MAX_INPUT)) throw new ConversationStoreError('invalid_text');
  const ref = conversationRef(viewer);
  return asStore(viewer, () =>
    withLockSync(`concierge-history-${ref.key}`, () => {
      const transcript = load(ref);
      transcript.droppedRequests = (transcript.droppedRequests ?? []).filter(
        (entry) => Date.now() - entry.createdAt < CONVERSATION_RETRY_WINDOW_MS
      );
      if (transcript.droppedRequests.some((entry) => entry.id === requestId))
        throw new ConversationStoreError('request_conflict');
      const existing = transcript.turns.find((turn) => turn.id === requestId);
      if (existing) {
        if (options.requireDiagnosticAdmission) {
          const request = transcript.executionRequests?.find(
            (entry) => entry.binding.request_id === requestId
          );
          const mapping = request && getFrontDeskExecutionMapping(request.binding);
          if (
            !request ||
            !mapping ||
            !frontDeskExecutionViewerMatches(viewer, mapping) ||
            !isFirstJobDiagnosticMapping(mapping) ||
            request.binding.diagnostic_protocol !== FIRST_JOB_DIAGNOSTIC_PROTOCOL ||
            request.status !== 'pending' ||
            request.revision !== request.binding.revision ||
            request.requestDigest !== request.binding.request_digest
          )
            throw new ConversationStoreError('diagnostic_admission_required');
        }
        // Legacy turns have no digest: only their exact stored display text can
        // replay. New turns bind the full input before redaction or truncation.
        const matches = existing.requestDigest
          ? existing.requestDigest === turnDigest
          : existing.text === text;
        if (!matches) throw new ConversationStoreError('request_conflict');
        if (existing.retryable && !existing.uncertain && existing.reply === undefined) {
          delete existing.retryable;
          publishTranscript(ref, transcript);
          return { id: existing.id, created: true, routing: existing.routing };
        }
        return {
          id: existing.id,
          created: false,
          reply: existing.reply,
          uncertain: existing.uncertain,
          routing: existing.routing,
        };
      }
      // Executable request identity outlives display turns and their retry tombstones.
      // A fresh timestamp must never recreate or reset an already bound task/revision.
      if (transcript.executionRequests?.some((entry) => entry.binding.request_id === requestId))
        throw new ConversationStoreError('request_conflict');
      if (
        options.requireDiagnosticAdmission &&
        !revisionInput &&
        (transcript.executionRequests ?? []).some((request) => !verifiedTerminalRecovery(request))
      )
        throw new ConversationStoreError('diagnostic_admission_required');
      const id = requestId;
      // Do not evict a pending turn that another process is still completing.
      if (transcript.turns.length === CONVERSATION_MAX_TURNS) {
        const completed = transcript.turns.findIndex(
          (turn) => turn.reply !== undefined || Date.now() - turn.createdAt >= PENDING_RETENTION_MS
        );
        if (completed < 0) throw new ConversationStoreError('invalid_history');
        const dropped = transcript.turns[completed];
        if (Date.now() - dropped.createdAt < CONVERSATION_RETRY_WINDOW_MS) {
          if (transcript.droppedRequests.length >= MAX_DROPPED_REQUESTS)
            throw new ConversationStoreError('invalid_history');
          transcript.droppedRequests.push({ id: dropped.id, createdAt: dropped.createdAt });
        }
        transcript.turns.splice(completed, 1);
      }
      // Intake classification is advisory only. Bind to this server-owned partition,
      // never to global TaskSession state or text recovered from old assistant replies.
      const revisionAdmission = revisionInput
        ? admitArtifactRevision(viewer, text, id, ref, transcript, revisionInput, locale)
        : undefined;
      let routed =
        revisionAdmission?.routed ??
        routeConversationTaskTurn(
          transcript.taskState ?? { tasks: [] },
          storedText(text, CONVERSATION_MAX_INPUT),
          id,
          Date.now(),
          locale
        );
      // Only this exact configured diagnostic command reserves executable work.
      // The request, outbox reference and queued answer share this one atomic write.
      const admission =
        revisionAdmission ?? executionAdmission(viewer, text, id, ref, routed.state, locale);
      if (
        options.requireDiagnosticAdmission &&
        (!admission ||
          !isFirstJobDiagnosticMapping(getFrontDeskExecutionMapping(admission.request.binding)))
      )
        throw new ConversationStoreError('diagnostic_admission_required');
      if (admission) {
        if (options.requireDiagnosticAdmission)
          admission.request.binding.diagnostic_protocol = FIRST_JOB_DIAGNOSTIC_PROTOCOL;
        routed = admission.routed;
        transcript.executionRequests = [...(transcript.executionRequests ?? []), admission.request];
      } else {
        const request = transcript.executionRequests?.find(
          (entry) => entry.binding.request_id === routed.decision.taskIds[0]
        );
        if (
          request &&
          request.status !== 'terminated_unstarted' &&
          (routed.decision.kind === 'followup' || routed.decision.kind === 'cancellation')
        ) {
          request.revision += 1;
          request.status =
            routed.decision.kind === 'cancellation' ? 'cancel_requested' : 'invalidated';
          request.requestDigest = createHash('sha256')
            .update(JSON.stringify({ previous: request.requestDigest, text }))
            .digest('hex');
          if (routed.decision.kind === 'cancellation') {
            routed.decision.reply = t('front_desk:execution_cancel_requested', undefined, locale);
          }
        }
        if (
          request?.status === 'terminated_unstarted' &&
          ['followup', 'cancellation'].includes(routed.decision.kind)
        ) {
          const originalTask = transcript.taskState?.tasks.find(
            (task) => task.id === request.binding.request_id
          );
          if (originalTask)
            routed.state.tasks = routed.state.tasks.map((task) =>
              task.id === originalTask.id ? structuredClone(originalTask) : task
            );
          routed.decision.reply =
            executionProjection(viewer, request, locale)?.text ??
            t('front_desk:execution_unverified', undefined, locale);
        }
        if (request && routed.decision.kind === 'status')
          routed.decision.reply =
            executionProjection(viewer, request, locale)?.text ?? routed.decision.reply;
      }
      syncExecutionReports(viewer, transcript);
      // Validate before publication too: a generated oversized/malformed reply must
      // never poison the durable transcript and make every subsequent read fail.
      if (
        !parseConversationTaskState(routed.state) ||
        !parseConversationTaskDecision(routed.decision)
      )
        throw new ConversationStoreError('invalid_history');
      transcript.taskState = routed.state;
      transcript.turns.push({
        routing: routed.decision,
        // Pure intake replies have no external execution. Publish their known
        // result atomically, so a crash cannot strand a replay as pending.
        ...(routed.decision.reply ? { reply: routed.decision.reply } : {}),
        id,
        text: storedText(text, CONVERSATION_MAX_INPUT),
        createdAt: Date.now(),
        requestDigest: turnDigest,
      });
      publishTranscript(ref, transcript);
      return { id, created: true, routing: routed.decision };
    })
  );
}

/** `outcome` comes from the runtime's structured result, never from reply text;
 * omit it when the reply did not come from the conversation runtime. */
export function completeConversationTurn(
  viewer: FrontDeskConversationViewer,
  id: string,
  reply: string,
  outcome?: ConversationTurnOutcome
): void {
  if (!validText(reply, CONVERSATION_MAX_REPLY)) throw new ConversationStoreError('invalid_text');
  const ref = conversationRef(viewer);
  asStore(viewer, () =>
    withLockSync(`concierge-history-${ref.key}`, () => {
      const transcript = load(ref);
      const turn = transcript.turns.find((entry) => entry.id === id);
      const boundedReply = storedText(reply, CONVERSATION_MAX_REPLY);
      if (
        turn?.routing?.reply &&
        turn.reply === boundedReply &&
        turn.routing.reply === boundedReply
      )
        return; // The inert intake result was already committed by reservation.
      if (!turn || turn.reply !== undefined) throw new ConversationStoreError('invalid_history');
      turn.reply = boundedReply;
      delete turn.uncertain;
      delete turn.retryable;
      const taskId = turn.routing?.taskIds[0];
      if (
        outcome &&
        taskId &&
        (turn.routing?.kind === 'new_request' || turn.routing?.kind === 'followup')
      ) {
        transcript.taskState = applyConversationTurnOutcome(
          transcript.taskState ?? { tasks: [] },
          taskId,
          outcome,
          id,
          boundedReply,
          Date.now()
        );
      }
      publishTranscript(ref, transcript);
    })
  );
}

/** Execution failure may have occurred after a side effect. Never turn it into
 * a success reply, remove the request, or automatically replay it. */
export function markConversationTurnUncertain(
  viewer: FrontDeskConversationViewer,
  id: string
): void {
  const ref = conversationRef(viewer);
  asStore(viewer, () =>
    withLockSync(`concierge-history-${ref.key}`, () => {
      const transcript = load(ref);
      const turn = transcript.turns.find((entry) => entry.id === id);
      if (!turn || turn.reply !== undefined) throw new ConversationStoreError('invalid_history');
      turn.uncertain = true;
      delete turn.retryable;
      publishTranscript(ref, transcript);
    })
  );
}

/** A bounded, display-only context projection for a fresh scoped model turn.
 * Pending requests are deliberately absent: restoring context must not retry
 * uncertain work or reactivate old approval metadata. */
export function completedConversationContext(viewer: FrontDeskConversationViewer): {
  messages: Array<{ role: 'user' | 'assistant'; text: string }>;
  truncated: boolean;
} {
  const history = readConversationHistory(viewer);
  const replies = new Map(
    history.messages
      .filter((message) => message.role === 'secretary')
      .map((message) => [message.id, message.text])
  );
  const pairs = history.messages
    .filter((message) => message.role === 'user')
    .flatMap((user) => {
      const reply = replies.get(user.id.replace(/-user$/, '-secretary'));
      return reply ? [{ user: user.text, reply }] : [];
    });
  const messages: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  let characters = 0;
  let truncated = false;
  for (let index = pairs.length - 1; index >= 0; index--) {
    const pair = pairs[index];
    const userText = pair.user.slice(0, 4000);
    const replyText = pair.reply.slice(0, 4000);
    if (messages.length + 2 > 20 || characters + userText.length + replyText.length > 16000) {
      truncated = true;
      break;
    }
    if (userText.length < pair.user.length || replyText.length < pair.reply.length)
      truncated = true;
    messages.unshift({ role: 'user', text: userText }, { role: 'assistant', text: replyText });
    characters += userText.length + replyText.length;
  }
  return { messages, truncated };
}

/** Validate explicit selection using the existing server-owned allowed lists. */
export function narrowFrontDeskConversationViewer(
  viewer: FrontDeskConversationViewer,
  selection: { tenant?: string | null; organizationId?: string | null; projectId?: string | null }
): FrontDeskConversationViewer {
  return { ...viewer, ...narrowSurfaceViewerScope(viewer, selection) };
}

/** Only a typed pre-execution admission rejection may call this. Unknown
 * execution outcomes never become retryable just because a client asks again. */
export function markConversationTurnNotStarted(
  viewer: FrontDeskConversationViewer,
  id: string
): void {
  const ref = conversationRef(viewer);
  asStore(viewer, () =>
    withLockSync(`concierge-history-${ref.key}`, () => {
      const transcript = load(ref);
      const turn = transcript.turns.find((entry) => entry.id === id);
      if (!turn || turn.reply !== undefined || turn.uncertain)
        throw new ConversationStoreError('invalid_history');
      turn.retryable = true;
      publishTranscript(ref, transcript);
    })
  );
}

function executionAdmission(
  viewer: FrontDeskConversationViewer,
  text: string,
  requestId: string,
  ref: ReturnType<typeof conversationRef>,
  state: ConversationTaskState,
  locale?: SupportedLocale
):
  | {
      routed: { state: ConversationTaskState; decision: ConversationTaskDecision };
      request: FrontDeskExecutionRequest;
    }
  | undefined {
  if (!isFrontDeskExecutionPublicViewer(viewer)) return undefined;
  const mapping = loadFrontDeskExecutionPolicy().mappings.find(
    (entry) => text === entry.exactCommand && frontDeskExecutionViewerMatches(viewer, entry)
  );
  if (!mapping || !isFrontDeskExecutionPublicViewer(mapping.viewer)) return undefined;
  let digest: string;
  try {
    if (!frontDeskRuntimeScope(viewer).tenant_slug) return undefined;
    digest = frontDeskMappingDigest(mapping);
  } catch {
    return undefined;
  }
  let task = state.tasks.find((entry) => entry.id === requestId);
  if (!task) {
    if (state.tasks.length >= CONVERSATION_TASK_MAX_TASKS) return undefined;
    task = {
      id: requestId,
      title: storedText(text, 512),
      requestText: storedText(text, CONVERSATION_MAX_INPUT),
      createdAt: Date.now(),
      updates: [],
      state: 'needs_execution',
    };
    state.tasks.push(task);
  }
  const requestDigest = createHash('sha256').update(text).digest('hex');
  const binding: FrontDeskExecutionBinding = {
    ...(isFirstJobDiagnosticMapping(mapping)
      ? { diagnostic_protocol: FIRST_JOB_DIAGNOSTIC_PROTOCOL }
      : {}),
    mapping_id: mapping.id,
    config_digest: digest,
    conversation_key: ref.key,
    request_id: requestId,
    revision: 1,
    request_digest: requestDigest,
    work_item_id:
      'WI-FD-' +
      createHash('sha256')
        .update(JSON.stringify([mapping.id, digest, ref.key, requestId, 1, requestDigest]))
        .digest('hex')
        .slice(0, 48),
  };
  task.workItemId = binding.work_item_id;
  task.state = 'needs_execution';
  delete task.result;
  delete state.clarification;
  return {
    routed: {
      state,
      decision: {
        kind: 'new_request',
        taskIds: [requestId],
        confidence: 'rule',
        authority: 'none',
        reply: t('front_desk:execution_acknowledged', undefined, locale),
      },
    },
    request: {
      binding,
      viewer: structuredClone(viewer),
      sessionId: ref.sessionId,
      revision: 1,
      requestDigest,
      status: 'pending',
      createdAt: Date.now(),
    },
  };
}
/** Reserve one immutable child under the transcript lock. Feedback never edits its parent. */
function admitArtifactRevision(
  viewer: FrontDeskConversationViewer,
  text: string,
  requestId: string,
  ref: ReturnType<typeof conversationRef>,
  transcript: Transcript,
  input: FrontDeskArtifactRevisionInput,
  locale?: SupportedLocale
): NonNullable<ReturnType<typeof executionAdmission>> {
  const parent = transcript.executionRequests?.find(
    (entry) => entry.binding.request_id === input.requestId
  );
  if (
    !parent ||
    parent.status !== 'pending' ||
    parent.binding.revision !== input.revision ||
    parent.revision !== input.revision
  )
    throw new ConversationStoreError('revision_target_unavailable');
  if (
    (transcript.executionRequests ?? []).some(
      (entry) =>
        entry.binding.parent_request_id === input.requestId && !verifiedTerminalRecovery(entry)
    )
  )
    throw new ConversationStoreError('revision_conflict');
  const mapping = getFrontDeskExecutionMapping(parent.binding);
  if (
    !mapping ||
    !frontDeskExecutionViewerMatches(viewer, mapping) ||
    (parent.binding.diagnostic_protocol !== undefined && !isFirstJobDiagnosticMapping(mapping))
  )
    throw new ConversationStoreError('revision_target_unavailable');
  const projection = executionProjection(viewer, parent, locale);
  if (
    projection?.status !== 'work_completed' ||
    projection.artifactSha256 !== input.sha256 ||
    !projection.artifactPath
  )
    throw new ConversationStoreError('revision_target_unavailable');
  if ((parent.binding.receipt_format ?? 'readable') === input.format)
    throw new ConversationStoreError('invalid_revision');
  const state = transcript.taskState ?? { tasks: [] };
  if (
    state.tasks.length >= CONVERSATION_TASK_MAX_TASKS ||
    input.revision >= CONVERSATION_TASK_MAX_TASKS
  )
    throw new ConversationStoreError('revision_conflict');
  const requestDigest = frontDeskArtifactRevisionDigest(input);
  const binding: FrontDeskExecutionBinding = {
    ...(parent.binding.diagnostic_protocol !== undefined || isFirstJobDiagnosticMapping(mapping)
      ? { diagnostic_protocol: FIRST_JOB_DIAGNOSTIC_PROTOCOL }
      : {}),
    mapping_id: mapping.id,
    config_digest: frontDeskMappingDigest(mapping),
    conversation_key: ref.key,
    request_id: requestId,
    revision: input.revision + 1,
    request_digest: requestDigest,
    work_item_id:
      'WI-FD-' +
      createHash('sha256')
        .update(
          JSON.stringify([
            mapping.id,
            parent.binding.config_digest,
            ref.key,
            requestId,
            input.revision + 1,
            requestDigest,
          ])
        )
        .digest('hex')
        .slice(0, 48),
    parent_request_id: input.requestId,
    parent_revision: input.revision,
    parent_sha256: input.sha256,
    receipt_format: input.format,
  };
  state.tasks.push({
    id: requestId,
    title: text,
    requestText: text,
    createdAt: Date.now(),
    updates: [],
    state: 'needs_execution',
    workItemId: binding.work_item_id,
  });
  delete state.clarification;
  return {
    routed: {
      state,
      decision: {
        kind: 'new_request',
        taskIds: [requestId],
        confidence: 'rule',
        authority: 'none',
        reply: t(
          'front_desk:artifact_revision_acknowledged',
          { revision: binding.revision },
          locale
        ),
      },
    },
    request: {
      binding,
      viewer: structuredClone(viewer),
      sessionId: ref.sessionId,
      revision: binding.revision,
      requestDigest,
      status: 'pending',
      createdAt: Date.now(),
    },
  };
}

function executionProjection(
  viewer: FrontDeskConversationViewer,
  request: FrontDeskExecutionRequest,
  locale?: SupportedLocale,
  rootDir?: string,
  includeArtifactBody = false
): FrontDeskExecutionProjection | undefined {
  if (request.status === 'terminated_unstarted') {
    const terminal = verifiedTerminalRecovery(request, rootDir);
    return terminal
      ? {
          status: 'terminated_unstarted',
          text: t('front_desk:execution_terminated_unstarted', undefined, locale),
          reportId: 'front-desk-terminated-' + request.binding.request_id,
        }
      : { status: 'uncertain', text: t('front_desk:execution_unverified', undefined, locale) };
  }
  if (request.status === 'cancel_requested')
    return {
      status: 'cancel_requested',
      text: t('front_desk:execution_cancel_requested', undefined, locale),
    };
  if (request.status === 'invalidated')
    return { status: 'blocked', text: t('front_desk:execution_invalidated', undefined, locale) };
  try {
    return projectFrontDeskExecution(viewer, request.binding, {
      locale,
      rootDir,
      includeArtifactBody,
    });
  } catch {
    return undefined;
  } // A report read failure never retries or re-dispatches work.
}
function syncExecutionReports(
  viewer: FrontDeskConversationViewer,
  transcript: Transcript
): boolean {
  const reports = transcript.executionReports ?? [];
  let changed = false;
  for (const request of transcript.executionRequests ?? []) {
    const projection = executionProjection(viewer, request);
    if (
      !projection?.reportId ||
      !validText(projection.reportId, 256) ||
      !validText(projection.text, CONVERSATION_MAX_REPLY)
    )
      continue;
    const index = reports.findIndex((report) => report.requestId === request.binding.request_id);
    const previous = index < 0 ? undefined : reports[index];
    if (previous?.id === projection.reportId && previous.status === projection.status) continue;
    if (
      reports.some(
        (report) =>
          report.id === projection.reportId && report.requestId !== request.binding.request_id
      )
    )
      continue;
    const report: FrontDeskExecutionReport = {
      id: projection.reportId,
      requestId: request.binding.request_id,
      status: projection.status,
      text: storedText(projection.text, CONVERSATION_MAX_REPLY),
      createdAt: Date.now(),
    };
    // A correction replaces this request's slot, so every admitted request can
    // always acquire its own receipt without an unbounded history of corrections.
    if (index >= 0) reports[index] = report;
    else if (reports.length < CONVERSATION_TASK_MAX_TASKS) reports.push(report);
    else continue;
    changed = true;
  }
  if (changed) transcript.executionReports = reports;
  return changed;
}

/** Front-desk-owned projection only. Executors never write transcripts. */
export function readConversationExecutionReports(
  viewer: FrontDeskConversationViewer
): FrontDeskExecutionReport[] {
  const ref = conversationRef(viewer);
  return asStore(viewer, () =>
    withLockSync(`concierge-history-${ref.key}`, () => {
      const transcript = load(ref);
      if (syncExecutionReports(viewer, transcript)) publishTranscript(ref, transcript);
      return structuredClone(transcript.executionReports ?? []);
    })
  );
}
/** Enumerate only explicitly configured partitions. No global transcript scan or bodies. */
export function listConfiguredFrontDeskExecutions(
  includeMapping?: (mapping: FrontDeskExecutionMapping) => boolean
): Array<{
  mapping: FrontDeskExecutionMapping;
  binding: FrontDeskExecutionBinding;
  request: Omit<FrontDeskExecutionRequest, 'binding' | 'viewer'>;
}> {
  const found: ReturnType<typeof listConfiguredFrontDeskExecutions> = [];
  for (const mapping of loadFrontDeskExecutionPolicy().mappings) {
    if (includeMapping && !includeMapping(mapping)) continue;
    if (!isFrontDeskExecutionPublicViewer(mapping.viewer)) continue;
    try {
      const ref = conversationRef(mapping.viewer);
      asStore(mapping.viewer, () => {
        for (const request of load(ref).executionRequests ?? []) {
          if (request.binding.mapping_id !== mapping.id) continue;
          const { binding, viewer: _viewer, ...summary } = request;
          found.push({ mapping, binding, request: summary });
        }
      });
    } catch {
      /* A malformed or inaccessible partition never gains execution authority. */
    }
  }
  return found;
}
/** Caller holds dispatch then coordination. The history fence spans revalidation, tombstone, and decline. */
export function withFrontDeskExecutionRecovery<T>(
  binding: FrontDeskExecutionBinding,
  callback: (
    request: FrontDeskExecutionRequest,
    terminate: (receipt: FrontDeskExecutionRecoveryReceipt) => FrontDeskExecutionRecoveryReceipt
  ) => T
): T {
  assertFrontDeskDispatchLockHeld(binding);
  assertUndispatchedWorkItemEvidenceHeld(binding);
  const mapping = getFrontDeskExecutionMapping(binding);
  if (!mapping || !isFrontDeskExecutionPublicViewer(mapping.viewer))
    throw new Error('recovery_mapping_unavailable');
  const ref = conversationRef(mapping.viewer);
  return asStore(mapping.viewer, () =>
    withLockSync('concierge-history-' + ref.key, () => {
      const request = readFrontDeskExecutionRecovery(binding);
      let active = true;
      try {
        const result = callback(request, (receipt) => {
          if (!active) throw new Error('recovery_callback_expired');
          assertFrontDeskDispatchLockHeld(binding);
          assertUndispatchedWorkItemEvidenceHeld(binding, {
            actionRef: receipt.action_ref,
            approvalRequestId: receipt.approval_request_id,
          });
          if (
            !parseFrontDeskExecutionRecoveryReceipt(receipt) ||
            recoveryEvidenceHash(receipt.binding) !== recoveryEvidenceHash(binding)
          )
            throw new Error('recovery_receipt_mismatch');
          const transcript = load(ref);
          const current = transcript.executionRequests?.find(
            (row) => row.binding.request_id === binding.request_id
          );
          if (
            !current ||
            recoveryEvidenceHash(current.binding) !== recoveryEvidenceHash(binding) ||
            current.revision !== binding.revision ||
            current.requestDigest !== binding.request_digest
          )
            throw new Error('recovery_request_changed');
          if (current.status === 'terminated_unstarted') {
            if (!current.recoveryReceipt || !sameRecoveryReceipt(current.recoveryReceipt, receipt))
              throw new Error('recovery_receipt_conflict');
            return structuredClone(current.recoveryReceipt);
          }
          if (current.status !== 'pending' || current.recoveryReceipt)
            throw new Error('recovery_request_changed');
          current.status = 'terminated_unstarted';
          current.recoveryReceipt = structuredClone(receipt);
          publishTranscript(ref, transcript);
          const readback = readFrontDeskExecutionRecovery(binding);
          if (
            readback.status !== 'terminated_unstarted' ||
            !readback.recoveryReceipt ||
            !sameRecoveryReceipt(readback.recoveryReceipt, receipt)
          )
            throw new Error('recovery_tombstone_readback_failed');
          return readback.recoveryReceipt;
        });
        if (result && typeof (result as { then?: unknown }).then === 'function')
          throw new Error('recovery callback must be synchronous');
        return result;
      } finally {
        active = false;
      }
    })
  );
}
function verifiedTerminalRecovery(request: FrontDeskExecutionRequest, rootDir?: string): boolean {
  const receipt = request.recoveryReceipt;
  if (request.status !== 'terminated_unstarted' || !receipt) return false;
  try {
    const allRows = readDotActionLedgerStrict({ rootDir });
    if (
      allRows.some(
        (row) =>
          row.action_ref !== receipt.action_ref &&
          (row.front_desk_execution?.request_id === request.binding.request_id ||
            row.front_desk_execution?.work_item_id === request.binding.work_item_id ||
            row.work_item_id === request.binding.work_item_id ||
            row.request_id === receipt.approval_request_id)
      )
    )
      return false;
    const rows = allRows.filter((row) => row.action_ref === receipt.action_ref);
    const latest = rows.at(-1);
    const original = rows.find(
      (row) => row.status === 'parked' && dotActionRecordHash(row) === receipt.action_hash
    );
    if (
      !latest ||
      latest.status !== 'declined' ||
      !latest.recovery_receipt ||
      !sameRecoveryReceipt(latest.recovery_receipt, receipt) ||
      !original ||
      rows.some(
        (row) =>
          row.status === 'dispatched' ||
          row.work_item_id ||
          row.request_id !== receipt.approval_request_id ||
          row.dot_id !== original.dot_id ||
          recoveryEvidenceHash(row.front_desk_execution) !==
            recoveryEvidenceHash(request.binding) ||
          (row.status === 'parked' && dotActionRecordHash(row) !== receipt.action_hash)
      )
    )
      return false;
    const approval = loadApprovalRequest('autonomy', receipt.approval_request_id);
    if (!approval || computeApprovalPayloadHash({ value: approval }) !== receipt.approval_hash)
      return false;
    const mapping = getFrontDeskExecutionMapping(request.binding);
    const charter = mapping ? findDotCharter(mapping.dotId, rootDir)?.charter : undefined;
    if (!mapping || !charter || charter.dot_id !== latest.dot_id) return false;
    const effect = firstJobApprovalEffect(charter, request.binding);
    const expected = frontDeskExecutionProposal(request.binding);
    if (
      receipt.member_id !== effect.ownerMemberId ||
      receipt.actor_id !== 'user:' + effect.ownerMemberId ||
      !['approved', 'applied'].includes(approval.status) ||
      approval.storageChannel !== 'autonomy' ||
      approval.kind !== 'channel-approval' ||
      approval.requestedBy !== 'dot:' + charter.dot_id ||
      approval.accountability?.finalDecision !== 'human_only' ||
      approval.accountability.payloadHash !== effect.payloadHash ||
      approval.accountability.effectBinding !== effect.effectBinding ||
      computeApprovalPayloadHash({ value: approval.scope }) !==
        computeApprovalPayloadHash({ value: effect.effect.scope }) ||
      approval.target ||
      approval.steering ||
      approval.workflow ||
      approval.veto ||
      (approval.decidedBy && approval.decidedBy !== receipt.actor_id) ||
      original.decision !== 'approve' ||
      original.actor_id !== 'dot:' + charter.dot_id ||
      original.action_id !== expected.action_id ||
      original.work_shape !== expected.work_shape ||
      original.pipeline_ref !== expected.pipeline_ref ||
      original.target !== expected.target ||
      original.intent !== expected.intent ||
      original.handoff_to ||
      original.proposal_hash !== dotProposalHash(charter.dot_id, expected)
    )
      return false;
    if (
      !readUndispatchedWorkItemEvidence(
        {
          workItemId: request.binding.work_item_id,
          actionRef: receipt.action_ref,
          approvalRequestId: receipt.approval_request_id,
          binding: request.binding,
        },
        { rootDir }
      ).ok
    )
      return false;
    assertFrontDeskRecoveryOutputsAbsent(charter, request.binding, original, mapping);
    return true;
  } catch {
    return false;
  }
}

/** Full intake/executor inspection adds current parent artifact and sibling evidence. */
export function inspectFrontDeskExecution(
  binding: FrontDeskExecutionBinding,
  charter: Parameters<typeof inspectFrontDeskPendingRequest>[1],
  options: { rootDir?: string } = {}
):
  | {
      ok: true;
      mapping: FrontDeskExecutionMapping;
      requestText: string;
      artifactPath: string;
      expectedContent: string;
    }
  | { ok: false; reason: string } {
  const checked = inspectFrontDeskPendingRequest(binding, charter, options);
  if (checked.ok === false) return checked;
  const { mapping, request, task, transcript } = checked;
  const blocked = (reason: string) => ({ ok: false as const, reason });
  return asStore(mapping.viewer, () => {
    try {
      if (binding.parent_request_id) {
        const parent = transcript.executionRequests?.find(
          (entry) => entry.binding.request_id === binding.parent_request_id
        );
        if (
          !parent ||
          parent.status !== 'pending' ||
          parent.binding.revision !== binding.parent_revision ||
          parent.revision !== binding.parent_revision ||
          parent.binding.config_digest !== binding.config_digest
        )
          return blocked('parent_revision_changed');
        const projection = executionProjection(mapping.viewer, parent, undefined, options.rootDir);
        if (
          projection?.status !== 'work_completed' ||
          projection.artifactSha256 !== binding.parent_sha256
        )
          return blocked('parent_artifact_unverified');
        const children =
          transcript.executionRequests?.filter(
            (entry) =>
              entry.binding.parent_request_id === binding.parent_request_id &&
              !verifiedTerminalRecovery(entry, options.rootDir)
          ) ?? [];
        if (children.length !== 1 || children[0].binding.request_id !== binding.request_id)
          return blocked('revision_conflict');
      }

      return {
        ok: true,
        mapping,
        requestText: task.requestText,
        artifactPath: frontDeskExecutionArtifactPath(binding, mapping),
        expectedContent: frontDeskExecutionExpectedContent(binding, mapping, request.sessionId),
      };
    } catch {
      return blocked('request_unavailable');
    }
  });
}
