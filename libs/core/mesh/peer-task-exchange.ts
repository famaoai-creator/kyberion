/**
 * Typed peer tasks: propose → recipient-local acceptance → WorkItem execution
 * → artifact references back to the proposer.
 *
 * A peer may only *name* a task type. What that type runs is decided by the
 * recipient's own task catalog
 * (`knowledge/confidential/<tenant>/connections/peer-tasks.json`): a fixed
 * pipeline or a fixed `pnpm` script with fixed arguments, plus the peers
 * allowed to ask for it. The proposal carries no parameters, so peer text
 * never reaches an argv, a pipeline input or a prompt.
 *
 * States are kept distinct, as the communication model requires: transport
 * receipt (the HTTP reply says "pending"), recipient acceptance (an operator
 * runs `peer:task accept` locally), execution (a WorkItem with source `peer`)
 * and the result message (`status` kind, stable message id, resendable).
 * Artifacts stay on the recipient; the result names them by repo-relative
 * path, sha256 and size only.
 *
 * Both sides record every state change in an append-only ledger
 * (`active/shared/runtime/peer-messaging/tenants/<tenant>/peers/<local>/task-exchange.jsonl`)
 * whose latest row per `<direction>:<task_id>` is the task's current state.
 */

import * as crypto from 'node:crypto';
import { z } from 'zod';

import * as os from 'node:os';

import { createLogger } from '../logger.js';
import { withLock } from '../foundation/lock-utils.js';
import { isPidAlive } from '../workforce/workspace-process-identity.js';
import { withExecutionContext } from '../authority.js';
import { isValidTenantSlug } from '../entity-scope.js';
import { pathResolver } from '../path-resolver.js';
import { nowIso } from '../foundation/time.js';
import { readJson } from '../foundation/json.js';
import { isRecord } from '../foundation/text.js';
import { safeExecResultAsync, safeExistsSync } from '../secure-io.js';
import { appendGovernedArtifactJsonl, writeScopedArtifact } from '../workforce/artifact-store.js';
import { createWorkItemIfAbsent, updateWorkItem } from '../workforce/work-coordination.js';
import {
  compactPeerLedgerAfterAppend,
  peerRuntimeLogicalPath,
  streamPeerStoreRecords,
  type PeerMessageEnvelope,
} from './peer-messaging.js';
import {
  PEER_CATALOG_READER_ROLE,
  sendPeerConversationMessageToPeer,
  type PeerConversationTranscriptEntry,
} from './peer-conversation.js';

const log = createLogger('peer-task-exchange');

const LEDGER_SEGMENT = 'task-exchange.jsonl';
const LEDGER_ROLE = 'infrastructure_sentinel' as const;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;
const SUMMARY_MAX_CHARS = 1000;
const RESULT_EXCERPT_MAX_CHARS = 1500;
const LOG_MAX_CHARS = 1_000_000;
const DELIVERY_TIMEOUT_MS = 10_000;
/** Clock skew tolerated on a peer's requested_at / expires_at. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Pending inbound tasks kept per remote peer; more are refused without a ledger row. */
const MAX_PENDING_PER_PEER = 20;
/** Grace after an execution's timeout before `resume --force` may take it over. */
const EXECUTION_GRACE_MS = 60 * 1000;

const TASK_TYPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const TASK_ID_PATTERN = /^PTK-[A-Za-z0-9-]{8,80}$/;
const PEER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PNPM_SCRIPT_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
const PIPELINE_PATH_PATTERN = /^pipelines\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.json$/;

export const PEER_TASK_REQUEST_KIND = 'peer-task-request';
export const PEER_TASK_RESULT_KIND = 'peer-task-result';

// ---------------------------------------------------------------------------
// Wire contracts
// ---------------------------------------------------------------------------

const PeerTaskRequestSchema = z
  .object({
    kind: z.literal(PEER_TASK_REQUEST_KIND),
    version: z.literal(1),
    task_id: z.string().regex(TASK_ID_PATTERN),
    task_type: z.string().regex(TASK_TYPE_PATTERN),
    summary: z.string().trim().min(1).max(SUMMARY_MAX_CHARS),
    tenant_id: z.string().refine(isValidTenantSlug, 'invalid tenant id'),
    sender_peer_id: z.string().regex(PEER_ID_PATTERN),
    recipient_peer_id: z.string().regex(PEER_ID_PATTERN),
    requested_at: z.string().datetime(),
    expires_at: z.string().datetime(),
  })
  .strict();
export type PeerTaskRequest = z.infer<typeof PeerTaskRequestSchema>;

const PeerTaskArtifactRefSchema = z
  .object({
    ref: z.string().min(1).max(512),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    media_type: z.string().min(1).max(100),
    location: z.literal('recipient_local'),
  })
  .strict();
export type PeerTaskArtifactRef = z.infer<typeof PeerTaskArtifactRefSchema>;

export const PEER_TASK_RESULT_STATUSES = ['completed', 'failed', 'rejected'] as const;
const PeerTaskResultSchema = z
  .object({
    kind: z.literal(PEER_TASK_RESULT_KIND),
    version: z.literal(1),
    task_id: z.string().regex(TASK_ID_PATTERN),
    task_type: z.string().regex(TASK_TYPE_PATTERN),
    status: z.enum(PEER_TASK_RESULT_STATUSES),
    summary: z.string().max(RESULT_EXCERPT_MAX_CHARS + SUMMARY_MAX_CHARS),
    work_item_id: z.string().min(1).max(200).optional(),
    exit_code: z.number().int().nullable().optional(),
    artifacts: z.array(PeerTaskArtifactRefSchema).max(16),
    finished_at: z.string().datetime(),
  })
  .strict();
export type PeerTaskResult = z.infer<typeof PeerTaskResultSchema>;

export function parsePeerTaskRequest(value: unknown): PeerTaskRequest {
  const parsed = PeerTaskRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid_peer_task_request:${parsed.error.message}`);
  return parsed.data;
}

export function parsePeerTaskResult(value: unknown): PeerTaskResult {
  const parsed = PeerTaskResultSchema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid_peer_task_result:${parsed.error.message}`);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Recipient task catalog
// ---------------------------------------------------------------------------

const PeerTaskExecutorSchema = z.discriminatedUnion('kind', [
  z
    .object({ kind: z.literal('pipeline'), pipeline: z.string().regex(PIPELINE_PATH_PATTERN) })
    .strict(),
  z
    .object({
      kind: z.literal('pnpm_script'),
      script: z.string().regex(PNPM_SCRIPT_PATTERN),
      args: z.array(z.string().min(1).max(200)).max(16).default([]),
    })
    .strict(),
]);
export type PeerTaskExecutor = z.infer<typeof PeerTaskExecutorSchema>;

const PeerTaskCatalogEntrySchema = z
  .object({
    task_type: z.string().regex(TASK_TYPE_PATTERN),
    description: z.string().min(1).max(500),
    executor: PeerTaskExecutorSchema,
    allowed_from_peers: z.array(z.string().regex(PEER_ID_PATTERN)).min(1),
    timeout_ms: z.number().int().positive().max(MAX_TIMEOUT_MS).default(DEFAULT_TIMEOUT_MS),
    /**
     * Send an excerpt of the task output to the proposer. Off by default: the
     * output stays in the recipient's artifacts and only status, exit code and
     * artifact references leave the host.
     */
    share_output_excerpt: z.boolean().default(false),
  })
  .strict();
export type PeerTaskCatalogEntry = z.infer<typeof PeerTaskCatalogEntrySchema>;

const PeerTaskCatalogSchema = z
  .object({
    version: z.literal(1),
    tasks: z.array(PeerTaskCatalogEntrySchema),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>();
    for (const entry of catalog.tasks) {
      if (seen.has(entry.task_type)) {
        ctx.addIssue({ code: 'custom', message: `duplicate task_type ${entry.task_type}` });
      }
      seen.add(entry.task_type);
    }
  });
export type PeerTaskCatalog = z.infer<typeof PeerTaskCatalogSchema>;

export function peerTaskCatalogPath(tenantId: string): string {
  if (!isValidTenantSlug(tenantId)) throw new Error(`invalid_peer_task_tenant_id:${tenantId}`);
  return `knowledge/confidential/${tenantId}/connections/peer-tasks.json`;
}

/**
 * Load the recipient's task catalog. The tenant catalog is read under the
 * tenant-bound `peer_catalog_reader` role; an explicit `catalogPath` (tests)
 * is read with the caller's own authority. A missing catalog means no task
 * type is offered.
 */
export function loadPeerTaskCatalog(
  tenantId: string,
  options: { catalogPath?: string } = {}
): PeerTaskCatalog {
  const read = (logicalPath: string): PeerTaskCatalog => {
    const resolved = pathResolver.resolve(logicalPath);
    if (!safeExistsSync(resolved)) return { version: 1, tasks: [] };
    const raw = readJson<unknown>(resolved);
    const parsed = PeerTaskCatalogSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`invalid_peer_task_catalog:${parsed.error.message}`);
    return parsed.data;
  };
  if (options.catalogPath) return read(options.catalogPath);
  return withExecutionContext(
    PEER_CATALOG_READER_ROLE,
    () => read(peerTaskCatalogPath(tenantId)),
    undefined,
    tenantId
  );
}

function catalogEntryFor(
  catalog: PeerTaskCatalog,
  taskType: string,
  remotePeerId: string
): PeerTaskCatalogEntry | { rejected: string } {
  const entry = catalog.tasks.find((candidate) => candidate.task_type === taskType);
  if (!entry) return { rejected: 'task_type_not_offered' };
  if (!entry.allowed_from_peers.includes(remotePeerId)) return { rejected: 'peer_not_allowed' };
  return entry;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export type PeerTaskDirection = 'inbound' | 'outbound';
export type PeerTaskState =
  'pending' | 'accepted' | 'running' | 'completed' | 'failed' | 'rejected' | 'expired';

export interface PeerTaskRecord {
  task_id: string;
  direction: PeerTaskDirection;
  tenant_id: string;
  local_peer_id: string;
  remote_peer_id: string;
  task_type: string;
  summary: string;
  session_id: string;
  request_message_id: string;
  requested_at: string;
  expires_at: string;
  state: PeerTaskState;
  decision?: {
    decision: 'accepted' | 'rejected';
    actor_id: string;
    reason: string;
    decided_at: string;
  };
  work_item_id?: string;
  /** Who is running an accepted task (single-runner guard for accept/resume). */
  execution?: { host: string; pid: number; started_at: string; deadline_at: string };
  /** Outbound only: whether the proposal reached the recipient. */
  proposal_delivery?: { status: 'sent' | 'failed'; at: string; error?: string };
  result?: PeerTaskResult;
  result_message_id?: string;
  result_delivery?: { status: 'sent' | 'failed'; at: string; error?: string };
  updated_at: string;
}

function ledgerLogicalPath(tenantId: string, localPeerId: string): string {
  return peerRuntimeLogicalPath(tenantId, localPeerId, LEDGER_SEGMENT);
}

function recordKey(record: Pick<PeerTaskRecord, 'direction' | 'task_id'>): string {
  return `${record.direction}:${record.task_id}`;
}

/** Composite compaction key — the same identity {@link listPeerTasks} folds on. */
function ledgerCompactionKey(record: Record<string, unknown>): string | undefined {
  return typeof record.task_id === 'string' && typeof record.state === 'string'
    ? recordKey({ direction: record.direction as PeerTaskDirection, task_id: record.task_id })
    : undefined;
}

export function listPeerTasks(
  tenantId: string,
  localPeerId: string,
  filter: { direction?: PeerTaskDirection; state?: PeerTaskState } = {}
): PeerTaskRecord[] {
  const rows = streamPeerStoreRecords<PeerTaskRecord>(
    ledgerLogicalPath(tenantId, localPeerId),
    (value) =>
      isRecord(value) && typeof value.task_id === 'string' && typeof value.state === 'string'
        ? (value as unknown as PeerTaskRecord)
        : null
  );
  const latest = new Map<string, PeerTaskRecord>();
  for (const row of rows) latest.set(recordKey(row), row);
  const now = Date.now();
  return Array.from(latest.values())
    .map((record) =>
      // A proposal nobody answered before its expiry is expired for the proposer too.
      record.direction === 'outbound' && record.state === 'pending' && isExpired(record, now)
        ? { ...record, state: 'expired' as const }
        : record
    )
    .filter((record) => !filter.direction || record.direction === filter.direction)
    .filter((record) => !filter.state || record.state === filter.state)
    .sort((left, right) => left.requested_at.localeCompare(right.requested_at));
}

export function getPeerTask(
  tenantId: string,
  localPeerId: string,
  direction: PeerTaskDirection,
  taskId: string
): PeerTaskRecord | null {
  return (
    listPeerTasks(tenantId, localPeerId, { direction }).find(
      (record) => record.task_id === taskId
    ) || null
  );
}

function appendRecord(record: PeerTaskRecord): PeerTaskRecord {
  const row = { ...record, updated_at: nowIso() };
  const logicalPath = ledgerLogicalPath(row.tenant_id, row.local_peer_id);
  appendGovernedArtifactJsonl(LEDGER_ROLE, logicalPath, row);
  // Readers use only the latest row per direction:task_id — fold the rest.
  compactPeerLedgerAfterAppend(logicalPath, ledgerCompactionKey);
  return row;
}

function stableId(prefix: string, taskId: string): string {
  return `${prefix}-${crypto.createHash('sha256').update(taskId).digest('hex').slice(0, 24)}`;
}

/** Stable result message id, so a resend is idempotent on both sides. */
export function peerTaskResultMessageId(taskId: string): string {
  return stableId('PCM-PTR', taskId);
}

function peerTaskWorkItemId(taskId: string): string {
  return stableId('WI-PEER-TASK', taskId);
}

function isExpired(record: Pick<PeerTaskRecord, 'expires_at'>, now = Date.now()): boolean {
  return Date.parse(record.expires_at) <= now;
}

// ---------------------------------------------------------------------------
// Proposer side
// ---------------------------------------------------------------------------

export interface ProposePeerTaskInput {
  tenantId: string;
  senderPeerId: string;
  recipientPeerId: string;
  taskType: string;
  summary: string;
  sessionId?: string;
  ttlMs?: number;
  /** Peer transport catalog override (tests); defaults to the tenant catalog. */
  peerCatalogPath?: string;
  timeoutMs?: number;
}

export async function proposePeerTask(input: ProposePeerTaskInput): Promise<{
  request: PeerTaskRequest;
  record: PeerTaskRecord;
  reply_text?: string;
}> {
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw new Error('invalid_peer_task_ttl');
  }
  const requestedAt = new Date();
  const request = parsePeerTaskRequest({
    kind: PEER_TASK_REQUEST_KIND,
    version: 1,
    task_id: `PTK-${requestedAt.getTime().toString(36).toUpperCase()}-${crypto.randomUUID()}`,
    task_type: input.taskType,
    summary: input.summary,
    tenant_id: input.tenantId,
    sender_peer_id: input.senderPeerId,
    recipient_peer_id: input.recipientPeerId,
    requested_at: requestedAt.toISOString(),
    expires_at: new Date(requestedAt.getTime() + ttlMs).toISOString(),
  });
  const sessionId =
    input.sessionId ||
    `PCS-${requestedAt.getTime().toString(36).toUpperCase()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  // Recorded before sending, so a proposal whose reply was lost can be resent
  // with the same task id instead of duplicated.
  const record = appendRecord({
    task_id: request.task_id,
    direction: 'outbound',
    tenant_id: input.tenantId,
    local_peer_id: input.senderPeerId,
    remote_peer_id: input.recipientPeerId,
    task_type: request.task_type,
    summary: request.summary,
    session_id: sessionId,
    request_message_id: stableId('PCM-PTQ', request.task_id),
    requested_at: request.requested_at,
    expires_at: request.expires_at,
    state: 'pending',
    updated_at: request.requested_at,
  });
  return sendPeerTaskProposal(record, input);
}

function requestFromRecord(record: PeerTaskRecord): PeerTaskRequest {
  return parsePeerTaskRequest({
    kind: PEER_TASK_REQUEST_KIND,
    version: 1,
    task_id: record.task_id,
    task_type: record.task_type,
    summary: record.summary,
    tenant_id: record.tenant_id,
    sender_peer_id: record.local_peer_id,
    recipient_peer_id: record.remote_peer_id,
    requested_at: record.requested_at,
    expires_at: record.expires_at,
  });
}

async function sendPeerTaskProposal(
  outbound: PeerTaskRecord,
  options: { peerCatalogPath?: string; timeoutMs?: number }
): Promise<{ request: PeerTaskRequest; record: PeerTaskRecord; reply_text?: string }> {
  const request = requestFromRecord(outbound);
  let sent: Awaited<ReturnType<typeof sendPeerConversationMessageToPeer>>;
  try {
    sent = await sendPeerConversationMessageToPeer({
      tenantId: outbound.tenant_id,
      senderPeerId: outbound.local_peer_id,
      recipientPeerId: outbound.remote_peer_id,
      sessionId: outbound.session_id,
      messageId: outbound.request_message_id,
      messageKind: 'handoff',
      topic: `peer-task:${request.task_type}`,
      text: `Task proposal ${request.task_type} (${request.task_id}): ${request.summary}`,
      metadata: { peer_task_request: request },
      ...(options.peerCatalogPath ? { catalogPath: options.peerCatalogPath } : {}),
      timeoutMs: options.timeoutMs ?? DELIVERY_TIMEOUT_MS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendRecord({
      ...outbound,
      proposal_delivery: { status: 'failed', at: nowIso(), error: message.slice(0, 500) },
    });
    throw new Error(
      `peer_task_proposal_not_delivered:${outbound.task_id} — ${message} | next: pnpm kyberion peer task resend-proposal --task-id ${outbound.task_id}`
    );
  }
  const reply = extractReply(sent.receipt);
  const rejection = reply?.payload?.peer_task_status === 'rejected';
  const record = appendRecord({
    ...outbound,
    state: rejection ? 'rejected' : outbound.state,
    proposal_delivery: { status: 'sent', at: nowIso() },
  });
  return { request, record, ...(reply?.text ? { reply_text: reply.text } : {}) };
}

/** Resend a recorded proposal with its original task id and message id. Idempotent. */
export async function resendPeerTaskProposal(input: {
  tenantId: string;
  localPeerId: string;
  taskId: string;
  peerCatalogPath?: string;
  timeoutMs?: number;
}): Promise<{ request: PeerTaskRequest; record: PeerTaskRecord; reply_text?: string }> {
  const record = getPeerTask(input.tenantId, input.localPeerId, 'outbound', input.taskId);
  if (!record) throw new Error(`peer_task_not_found:${input.taskId}`);
  if (record.state !== 'pending') {
    throw new Error(`peer_task_not_resendable:${record.task_id}:${record.state}`);
  }
  return sendPeerTaskProposal(record, input);
}

function extractReply(receipt: unknown): PeerConversationTranscriptEntry | undefined {
  if (!isRecord(receipt)) return undefined;
  const response = isRecord(receipt.response) ? receipt.response : undefined;
  const reply = response && isRecord(response.reply) ? response.reply : undefined;
  return reply as unknown as PeerConversationTranscriptEntry | undefined;
}

// ---------------------------------------------------------------------------
// Receive path (peer conversation server)
// ---------------------------------------------------------------------------

export interface PeerTaskInboundContext {
  tenantId: string;
  localPeerId: string;
  sessionId: string;
  message: PeerConversationTranscriptEntry;
  envelope: PeerMessageEnvelope;
  /** Task catalog override (tests); defaults to the tenant task catalog. */
  taskCatalogPath?: string;
}

/** True when an inbound conversation message belongs to the task exchange. */
export function isPeerTaskMessage(message: PeerConversationTranscriptEntry): boolean {
  return (
    (message.kind === 'handoff' && isRecord(message.metadata?.peer_task_request)) ||
    (message.kind === 'status' && isRecord(message.metadata?.peer_task_result))
  );
}

/**
 * Record an inbound task request (pending local acceptance, or rejected when
 * the local catalog does not offer the type to this peer) or an inbound
 * result for a task this peer proposed. Returns the transport reply. Never
 * executes anything.
 */
export function handleInboundPeerTaskMessage(
  context: PeerTaskInboundContext
): PeerConversationTranscriptEntry {
  const { message, envelope } = context;
  const remotePeerId = envelope.sender_peer_id;
  if (message.kind === 'status') {
    const result = parsePeerTaskResult(message.metadata?.peer_task_result);
    const outbound = getPeerTask(context.tenantId, context.localPeerId, 'outbound', result.task_id);
    if (
      !outbound ||
      outbound.remote_peer_id !== remotePeerId ||
      outbound.task_type !== result.task_type
    ) {
      throw new Error(`peer_task_unknown:${result.task_id}`);
    }
    if (!outbound.result) {
      appendRecord({
        ...outbound,
        state: result.status,
        result,
        ...(result.work_item_id ? { work_item_id: result.work_item_id } : {}),
      });
      log.info(`task ${result.task_id} (${result.task_type}) ${result.status} on ${remotePeerId}`);
    }
    return transportReply(
      context,
      stableId('PCR-PTR', result.task_id),
      'status',
      `Result for ${result.task_id} recorded by ${context.localPeerId}.`,
      {
        peer_task_id: result.task_id,
        ack: true,
      }
    );
  }

  const request = parsePeerTaskRequest(message.metadata?.peer_task_request);
  if (
    request.sender_peer_id !== remotePeerId ||
    request.recipient_peer_id !== context.localPeerId
  ) {
    throw new Error(`peer_task_identity_mismatch:${request.task_id}`);
  }
  if (request.tenant_id !== context.tenantId || envelope.tenant_id !== context.tenantId) {
    throw new Error(`peer_task_tenant_mismatch:${request.task_id}`);
  }
  const replyId = stableId('PCR-PTQ', request.task_id);
  const existing = getPeerTask(context.tenantId, context.localPeerId, 'inbound', request.task_id);
  if (existing) {
    return transportReply(context, replyId, 'reply', describeInboundState(existing), {
      peer_task_id: existing.task_id,
      peer_task_status: existing.state,
    });
  }
  const base: PeerTaskRecord = {
    task_id: request.task_id,
    direction: 'inbound',
    tenant_id: context.tenantId,
    local_peer_id: context.localPeerId,
    remote_peer_id: remotePeerId,
    task_type: request.task_type,
    summary: request.summary,
    session_id: context.sessionId,
    request_message_id: message.message_id,
    requested_at: request.requested_at,
    expires_at: request.expires_at,
    state: 'pending',
    updated_at: request.requested_at,
  };
  const rejection = receiptRejection(context, request, remotePeerId);
  if (rejection) {
    // No ledger row: a refused proposal changes no local state, so a peer
    // cannot grow the ledger by sending proposals that are never offered.
    log.info(
      `task ${request.task_id} (${request.task_type}) from ${remotePeerId} refused: ${rejection}`
    );
    return transportReply(
      context,
      replyId,
      'reply',
      `Task ${request.task_id} (${request.task_type}) is rejected on ${context.localPeerId} (${rejection}).`,
      { peer_task_id: request.task_id, peer_task_status: 'rejected', reason: rejection }
    );
  }
  const record = appendRecord(base);
  log.info(
    `task ${record.task_id} (${record.task_type}) from ${remotePeerId} pending local acceptance`
  );
  return transportReply(context, replyId, 'reply', describeInboundState(record), {
    peer_task_id: record.task_id,
    peer_task_status: 'pending',
  });
}

/** Why a proposal is refused on receipt, or undefined when it may wait for acceptance. */
function receiptRejection(
  context: PeerTaskInboundContext,
  request: PeerTaskRequest,
  remotePeerId: string
): string | undefined {
  const now = Date.now();
  const requestedAt = Date.parse(request.requested_at);
  const expiresAt = Date.parse(request.expires_at);
  // The proposer picks both times; bound them so a task cannot wait forever.
  if (requestedAt > now + CLOCK_SKEW_MS) return 'requested_in_future';
  if (expiresAt <= now) return 'expired';
  if (expiresAt - requestedAt > MAX_TTL_MS || expiresAt > now + MAX_TTL_MS + CLOCK_SKEW_MS) {
    return 'ttl_too_long';
  }
  const entry = catalogEntryFor(
    loadPeerTaskCatalog(context.tenantId, { catalogPath: context.taskCatalogPath }),
    request.task_type,
    remotePeerId
  );
  if ('rejected' in entry) return entry.rejected;
  const pending = listPeerTasks(context.tenantId, context.localPeerId, {
    direction: 'inbound',
    state: 'pending',
  }).filter((task) => task.remote_peer_id === remotePeerId && !isExpired(task, now));
  if (pending.length >= MAX_PENDING_PER_PEER) return 'too_many_pending';
  return undefined;
}

function describeInboundState(record: PeerTaskRecord): string {
  if (record.state === 'pending') {
    return `Task ${record.task_id} (${record.task_type}) is pending local acceptance on ${record.local_peer_id}.`;
  }
  const reason = record.decision?.reason ? ` (${record.decision.reason})` : '';
  return `Task ${record.task_id} (${record.task_type}) is ${record.state} on ${record.local_peer_id}${reason}.`;
}

function transportReply(
  context: PeerTaskInboundContext,
  messageId: string,
  kind: 'reply' | 'status',
  text: string,
  payload: Record<string, unknown>
): PeerConversationTranscriptEntry {
  return {
    message_id: messageId,
    kind,
    direction: 'outbound',
    sender_peer_id: context.localPeerId,
    recipient_peer_id: context.envelope.sender_peer_id,
    text,
    created_at: nowIso(),
    metadata: { ack: true },
    payload: { ...payload, mission_controller_mutation: 'deny' },
  };
}

// ---------------------------------------------------------------------------
// Recipient-local decision + execution
// ---------------------------------------------------------------------------

export interface PeerTaskExecutionOutput {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  started_at: string;
  finished_at: string;
}

export type PeerTaskExecutorRunner = (
  entry: PeerTaskCatalogEntry,
  context: { tenantId: string }
) => Promise<PeerTaskExecutionOutput>;

/** Fixed argv per catalog entry; nothing from the proposal reaches it. */
export function peerTaskExecutorArgv(executor: PeerTaskExecutor): string[] {
  return executor.kind === 'pipeline'
    ? ['-s', 'pipeline', '--input', executor.pipeline]
    : ['-s', executor.script, ...executor.args];
}

export const runPeerTaskExecutor: PeerTaskExecutorRunner = async (entry, context) => {
  const startedAt = nowIso();
  const result = await safeExecResultAsync('pnpm', peerTaskExecutorArgv(entry.executor), {
    cwd: pathResolver.rootDir(),
    timeoutMs: entry.timeout_ms,
    env: { KYBERION_TENANT: context.tenantId, NO_COLOR: '1' },
  });
  return {
    exit_code: result.status,
    stdout: result.stdout,
    stderr: result.error && !result.stderr ? String(result.error.message) : result.stderr,
    started_at: startedAt,
    finished_at: nowIso(),
  };
};

/** Stores one task artifact and returns its repo-relative path. */
export type PeerTaskArtifactWriter = (input: {
  tenantId: string;
  name: string;
  content: string;
}) => string;

/**
 * Narrow tenant-bound writer for task results: only
 * `active/shared/artifacts/confidential/<tenant>/report/peer-tasks/` and that
 * tenant's artifact index (security-policy.json).
 */
export const PEER_TASK_ARTIFACT_WRITER_ROLE = 'peer_task_artifact_writer';

/** Tenant-scoped report artifact (`active/shared/artifacts/confidential/<tenant>/report/peer-tasks/...`). */
export const writePeerTaskArtifact: PeerTaskArtifactWriter = ({ tenantId, name, content }) =>
  withExecutionContext(
    PEER_TASK_ARTIFACT_WRITER_ROLE,
    () =>
      writeScopedArtifact({
        scope: { tenant: tenantId },
        artifact_class: 'report',
        name,
        content,
        format: 'text',
      }).repo_relative_path,
    undefined,
    tenantId
  );

export interface DecidePeerTaskInput {
  tenantId: string;
  localPeerId: string;
  taskId: string;
  decision: 'accepted' | 'rejected';
  actorId: string;
  reason: string;
  taskCatalogPath?: string;
  peerCatalogPath?: string;
  runner?: PeerTaskExecutorRunner;
  writeArtifact?: PeerTaskArtifactWriter;
  deliver?: boolean;
}

/**
 * The recipient operator's decision. `accepted` creates (or replays) the
 * WorkItem, runs the catalog executor, stores the output as tenant artifacts,
 * closes the WorkItem and sends the result; `rejected` sends a rejection.
 */
export async function decidePeerTask(input: DecidePeerTaskInput): Promise<PeerTaskRecord> {
  const actorId = input.actorId.trim();
  const reason = input.reason.trim();
  if (!actorId || !reason) throw new Error('peer_task_decision_requires_actor_and_reason');
  // The pending → decided transition is fenced, so two accepts (two operators,
  // a double invocation) cannot both claim the task.
  const claimed = await withTaskLock(input, async () => {
    let record = getPeerTask(input.tenantId, input.localPeerId, 'inbound', input.taskId);
    if (!record) throw new Error(`peer_task_not_found:${input.taskId}`);
    if (record.state !== 'pending')
      throw new Error(`peer_task_already_decided:${record.task_id}:${record.state}`);
    const decidedAt = nowIso();
    if (input.decision === 'rejected' || isExpired(record)) {
      const expired = input.decision === 'accepted';
      const why = expired ? 'expired before acceptance' : reason;
      record = appendRecord({
        ...record,
        state: expired ? 'expired' : 'rejected',
        decision: { decision: 'rejected', actor_id: actorId, reason: why, decided_at: decidedAt },
        result: buildResult(record, 'rejected', `Rejected by ${record.local_peer_id}: ${why}`, []),
      });
      return { record, entry: undefined };
    }
    const entry = catalogEntryFor(
      loadPeerTaskCatalog(input.tenantId, { catalogPath: input.taskCatalogPath }),
      record.task_type,
      record.remote_peer_id
    );
    if ('rejected' in entry)
      throw new Error(`peer_task_not_offered:${record.task_id}:${entry.rejected}`);
    record = appendRecord({
      ...record,
      state: 'running',
      decision: { decision: 'accepted', actor_id: actorId, reason, decided_at: decidedAt },
      execution: executionOwner(entry),
    });
    return { record, entry };
  });
  let record = claimed.record;
  if (claimed.entry) record = await executeAcceptedPeerTask(input, record, claimed.entry);
  if (input.deliver !== false) record = await deliverPeerTaskResult({ ...input, record });
  if (record.state === 'expired') throw new Error(`peer_task_expired:${record.task_id}`);
  return record;
}

function withTaskLock<T>(
  input: { tenantId: string; localPeerId: string; taskId: string },
  fn: () => Promise<T>
): Promise<T> {
  return withLock(
    `peer-task-${stableId('lock', `${input.tenantId}/${input.localPeerId}/${input.taskId}`)}`,
    fn
  );
}

function executionOwner(entry: PeerTaskCatalogEntry): NonNullable<PeerTaskRecord['execution']> {
  const startedAt = Date.now();
  return {
    host: os.hostname(),
    pid: process.pid,
    started_at: new Date(startedAt).toISOString(),
    deadline_at: new Date(startedAt + entry.timeout_ms + EXECUTION_GRACE_MS).toISOString(),
  };
}

/**
 * Whether another runner may still be executing this task. A runner on this
 * host is live while its process is alive; its executor child is not
 * detached but can outlive a killed parent, so a dead parent before the
 * deadline is still treated as possibly live (resume needs --force).
 */
function executionMayBeLive(record: PeerTaskRecord, now = Date.now()): boolean {
  const execution = record.execution;
  if (!execution) return false;
  if (execution.host === os.hostname() && isPidAlive(execution.pid)) return true;
  return Date.parse(execution.deadline_at) > now;
}

/** Whether `resume --force` may take over a possibly-live runner. */
function forceTakeoverAllowed(record: PeerTaskRecord, now = Date.now()): boolean {
  const execution = record.execution;
  if (!execution) return true;
  if (Date.parse(execution.deadline_at) <= now) return true;
  // Before the deadline only a runner whose process is gone may be taken over.
  return execution.host === os.hostname() && !isPidAlive(execution.pid);
}

/**
 * Run an accepted task: create (or replay) its WorkItem, run the catalog
 * executor, store the artifacts, close the WorkItem and record the result.
 * Idempotent up to the executor run, so an interrupted task can be resumed.
 */
async function executeAcceptedPeerTask(
  input: Omit<DecidePeerTaskInput, 'decision' | 'actorId' | 'reason' | 'deliver'>,
  accepted: PeerTaskRecord,
  entry: PeerTaskCatalogEntry
): Promise<PeerTaskRecord> {
  let record = accepted;
  // The tenant registration check runs under the caller's authority; the
  // tenant-bound catalog reader also grants this tenant's profile, so a plain
  // operator shell can accept without a broader role.
  const workItem = withExecutionContext(
    PEER_CATALOG_READER_ROLE,
    () =>
      createWorkItemIfAbsent({
        itemId: peerTaskWorkItemId(record.task_id),
        title: `Peer task ${record.task_type} from ${record.remote_peer_id}`,
        description: `Peer-supplied summary (untrusted): ${record.summary}\n\nPeer task ${record.task_id}; accepted by ${record.decision!.actor_id}: ${record.decision!.reason}`,
        status: 'in_progress',
        source: 'peer',
        sourceRef: `peer-task:${record.task_id}`,
        assigneePeerId: record.local_peer_id,
        labels: ['peer-task', record.task_type],
        context: { tenant_slug: input.tenantId, work_shape: 'service_operation' },
        metadata: {
          peer_task_id: record.task_id,
          remote_peer_id: record.remote_peer_id,
          executor: entry.executor,
        },
      }),
    undefined,
    input.tenantId
  );
  // A resumed task may find its WorkItem already closed by the interrupted run.
  if (workItem.status !== 'in_progress') {
    updateWorkItem({ itemId: workItem.item_id, status: 'in_progress' });
  }
  record = appendRecord({ ...record, state: 'running', work_item_id: workItem.item_id });

  const output = await (input.runner || runPeerTaskExecutor)(entry, { tenantId: input.tenantId });
  const status = output.exit_code === 0 ? 'completed' : 'failed';
  const artifacts = writeTaskArtifacts(
    input.writeArtifact || writePeerTaskArtifact,
    input.tenantId,
    record,
    entry,
    output,
    status
  );
  updateWorkItem({
    itemId: workItem.item_id,
    status: status === 'completed' ? 'done' : 'blocked',
    metadata: {
      ...(workItem.metadata || {}),
      peer_task_exit_code: output.exit_code,
      peer_task_artifacts: artifacts.map((artifact) => artifact.ref),
    },
  });
  record = appendRecord({
    ...record,
    state: status,
    result: buildResult(
      record,
      status,
      summarizeOutput(entry, output, status),
      artifacts,
      output.exit_code
    ),
  });
  return record;
}

/**
 * Resume an accepted task that stopped before recording a result (executor
 * crash, artifact write failure), then deliver the result. Refused while the
 * original runner may still be executing; `force` takes over only once its
 * deadline (timeout + grace) has passed.
 */
export async function resumePeerTask(
  input: Omit<DecidePeerTaskInput, 'decision' | 'actorId' | 'reason'> & { force?: boolean }
): Promise<PeerTaskRecord> {
  const claimed = await withTaskLock(input, async () => {
    const record = getPeerTask(input.tenantId, input.localPeerId, 'inbound', input.taskId);
    if (!record) throw new Error(`peer_task_not_found:${input.taskId}`);
    if (record.state !== 'running' || record.decision?.decision !== 'accepted' || record.result) {
      throw new Error(`peer_task_not_resumable:${record.task_id}:${record.state}`);
    }
    if (executionMayBeLive(record)) {
      if (!(input.force && forceTakeoverAllowed(record))) {
        throw new Error(
          `peer_task_still_running:${record.task_id} — pid ${record.execution?.pid} on ${record.execution?.host} until ${record.execution?.deadline_at}`
        );
      }
    }
    const entry = catalogEntryFor(
      loadPeerTaskCatalog(input.tenantId, { catalogPath: input.taskCatalogPath }),
      record.task_type,
      record.remote_peer_id
    );
    if ('rejected' in entry)
      throw new Error(`peer_task_not_offered:${record.task_id}:${entry.rejected}`);
    return { record: appendRecord({ ...record, execution: executionOwner(entry) }), entry };
  });
  const done = await executeAcceptedPeerTask(input, claimed.record, claimed.entry);
  return input.deliver === false ? done : deliverPeerTaskResult({ ...input, record: done });
}

function buildResult(
  record: PeerTaskRecord,
  status: PeerTaskResult['status'],
  summary: string,
  artifacts: PeerTaskArtifactRef[],
  exitCode?: number | null
): PeerTaskResult {
  return parsePeerTaskResult({
    kind: PEER_TASK_RESULT_KIND,
    version: 1,
    task_id: record.task_id,
    task_type: record.task_type,
    status,
    summary,
    ...(record.work_item_id ? { work_item_id: record.work_item_id } : {}),
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    artifacts,
    finished_at: nowIso(),
  });
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

function tail(text: string, maxChars: number): string {
  const trimmed = text.replace(ANSI_ESCAPE_PATTERN, '').trim();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(trimmed.length - maxChars + 1)}`;
}

function summarizeOutput(
  entry: PeerTaskCatalogEntry,
  output: PeerTaskExecutionOutput,
  status: 'completed' | 'failed'
): string {
  const head = `${entry.task_type} ${status} (exit ${output.exit_code ?? 'none'})`;
  if (!entry.share_output_excerpt) return head;
  const excerpt = tail(
    status === 'completed' ? output.stdout : output.stderr || output.stdout,
    RESULT_EXCERPT_MAX_CHARS
  );
  return excerpt ? `${head}\n${excerpt}` : head;
}

function artifactRef(path: string, content: string, mediaType: string): PeerTaskArtifactRef {
  const buffer = Buffer.from(content, 'utf8');
  return {
    ref: path,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    bytes: buffer.byteLength,
    media_type: mediaType,
    location: 'recipient_local',
  };
}

function writeTaskArtifacts(
  writeArtifact: PeerTaskArtifactWriter,
  tenantId: string,
  record: PeerTaskRecord,
  entry: PeerTaskCatalogEntry,
  output: PeerTaskExecutionOutput,
  status: 'completed' | 'failed'
): PeerTaskArtifactRef[] {
  const logText = [
    `# ${entry.task_type} (${record.task_id})`,
    `exit_code: ${output.exit_code ?? 'none'}`,
    '',
    '## stdout',
    tail(output.stdout, LOG_MAX_CHARS),
    '',
    '## stderr',
    tail(output.stderr, LOG_MAX_CHARS),
    '',
  ].join('\n');
  const reportText = `${JSON.stringify(
    {
      task_id: record.task_id,
      task_type: entry.task_type,
      remote_peer_id: record.remote_peer_id,
      work_item_id: record.work_item_id,
      executor: entry.executor,
      status,
      exit_code: output.exit_code,
      started_at: output.started_at,
      finished_at: output.finished_at,
    },
    null,
    2
  )}\n`;
  const write = (name: string, content: string, mediaType: string): PeerTaskArtifactRef => {
    const ref = writeArtifact({
      tenantId,
      name: `peer-tasks/${record.task_id.toLowerCase()}/${name}`,
      content,
    });
    return artifactRef(ref, content, mediaType);
  };
  return [
    write('report.json', reportText, 'application/json'),
    write('output.log', logText, 'text/plain'),
  ];
}

/** Send (or resend) the stored result to the proposer. Idempotent. */
export async function deliverPeerTaskResult(input: {
  tenantId: string;
  localPeerId: string;
  taskId?: string;
  record?: PeerTaskRecord;
  peerCatalogPath?: string;
}): Promise<PeerTaskRecord> {
  const record =
    input.record ||
    getPeerTask(input.tenantId, input.localPeerId, 'inbound', String(input.taskId || ''));
  if (!record) throw new Error(`peer_task_not_found:${input.taskId}`);
  if (!record.result) throw new Error(`peer_task_has_no_result:${record.task_id}`);
  const messageId = peerTaskResultMessageId(record.task_id);
  try {
    await sendPeerConversationMessageToPeer({
      tenantId: record.tenant_id,
      senderPeerId: record.local_peer_id,
      recipientPeerId: record.remote_peer_id,
      sessionId: record.session_id,
      messageId,
      messageKind: 'status',
      topic: `peer-task:${record.task_type}`,
      text: `Task ${record.task_id} (${record.task_type}) ${record.result.status}: ${record.result.summary.split('\n')[0]}`,
      metadata: { peer_task_result: record.result },
      ...(record.work_item_id ? { relatedWorkItemIds: [record.work_item_id] } : {}),
      ...(input.peerCatalogPath ? { catalogPath: input.peerCatalogPath } : {}),
      timeoutMs: DELIVERY_TIMEOUT_MS,
    });
    return appendRecord({
      ...record,
      result_message_id: messageId,
      result_delivery: { status: 'sent', at: nowIso() },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(
      `result for ${record.task_id} not delivered — ${message} | next: pnpm kyberion peer task resend-result --task-id ${record.task_id}`
    );
    return appendRecord({
      ...record,
      result_message_id: messageId,
      result_delivery: { status: 'failed', at: nowIso(), error: message.slice(0, 500) },
    });
  }
}
