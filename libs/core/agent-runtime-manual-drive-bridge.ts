/**
 * Durable control bridge for manual-drive workers (PI-14).
 *
 * A Chronos process cannot invoke a worker's in-memory action closure when the
 * worker runs under the supervisor daemon. This bridge persists only the safe
 * action projection plus command/result envelopes; approval payloads and
 * executor return values never cross the process boundary.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { readJsonIfPresent, appendJsonLine, readJsonLines } from './foundation/json.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import { withLock, withLockSync } from './src/lock-utils.js';
import type {
  AgentRuntimeManualDriver,
  ManualDriveApprovalDecision,
  ManualDriveActionInfo,
  ManualDriveExecutionResult,
  ManualDriveExecutionStatus,
} from './agent-runtime-manual-drive.js';
import { normalizeEventScope, type EventScope, type EventScopeInput } from './event-scope.js';

const BRIDGE_ROOT = pathResolver.shared('coordination/agent-runtime/manual-drive');
const DEFAULT_POLL_INTERVAL_MS = 100;
const DESCRIPTOR_TTL_MS = 30_000;
const BRIDGE_ACTION_KINDS = new Set([
  'append_entry',
  'stream_assistant',
  'execute_tool',
  'hook',
  'sleep',
  'apply_pending_write',
  'consume_queue_item',
]);

type ManualDriverCommandRecord = {
  command_id: string;
  agent_id: string;
  action_id: string;
  requested_at: string;
  requested_by: string;
  resumes_command_id?: string;
};

type ManualDriverCommandResultRecord = {
  command_id: string;
  agent_id: string;
  action_id: string;
  phase: 'started' | 'completed';
  recorded_at: string;
  status?: ManualDriveExecutionStatus;
  action?: ManualDriveActionInfo;
  approval?: ManualDriveApprovalDecision;
  /** Deliberately stable and detail-free; raw executor errors stay in-process. */
  error_code?: 'manual_drive_command_failed';
};

export interface DurableManualDriverDescriptor {
  version: 1;
  agent_id: string;
  owner_id: string;
  scope: EventScope;
  status: 'online';
  updated_at: string;
  expires_at: string;
  action: ManualDriveActionInfo | null;
}

export interface ManualDriverCommandReceipt {
  commandId: string;
  agentId: string;
  actionId: string;
  requestedAt: string;
  resumesCommandId?: string;
}

export interface ManualDriverCommandStatus {
  commandId: string;
  agentId: string;
  actionId: string;
  state: 'queued' | 'running' | 'completed' | 'cancelled';
  status?: ManualDriveExecutionStatus;
  action?: ManualDriveActionInfo;
  approval?: ManualDriveApprovalDecision;
  errorCode?: 'manual_drive_command_failed';
  resumesCommandId?: string;
}

export interface ManualDriverBridgeOptions {
  agentId: string;
  driver: AgentRuntimeManualDriver;
  scope: EventScopeInput;
  pollIntervalMs?: number;
}

function normalizeAgentId(agentId: string): string {
  const normalized = agentId.trim();
  if (!normalized) throw new Error('[MANUAL_DRIVE_AGENT_ID] agentId is required.');
  return normalized;
}

function bridgeKey(agentId: string): string {
  return createHash('sha256').update(normalizeAgentId(agentId)).digest('hex');
}

function bridgePaths(agentId: string): {
  descriptorPath: string;
  commandPath: string;
  cancellationPath: string;
  resultPath: string;
  lockId: string;
} {
  const key = bridgeKey(agentId);
  assertSafeRepositoryPath(BRIDGE_ROOT, { allowMissingLeaf: true });
  return {
    descriptorPath: assertSafeRepositoryPath(path.join(BRIDGE_ROOT, `${key}.descriptor.json`), {
      allowMissingLeaf: true,
    }),
    commandPath: assertSafeRepositoryPath(path.join(BRIDGE_ROOT, `${key}.commands.jsonl`), {
      allowMissingLeaf: true,
    }),
    cancellationPath: assertSafeRepositoryPath(
      path.join(BRIDGE_ROOT, `${key}.cancellations.jsonl`),
      { allowMissingLeaf: true }
    ),
    resultPath: assertSafeRepositoryPath(path.join(BRIDGE_ROOT, `${key}.results.jsonl`), {
      allowMissingLeaf: true,
    }),
    lockId: `manual-drive-bridge-${key}`,
  };
}

function ensureBridgeRoot(): void {
  assertSafeRepositoryPath(BRIDGE_ROOT, { allowMissingLeaf: true });
  safeMkdir(BRIDGE_ROOT, { recursive: true });
}

function isoNow(): string {
  return nowIso();
}

function projectBridgeActionInfo(value: unknown): ManualDriveActionInfo | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[MANUAL_DRIVE_BRIDGE_CORRUPT] action info is invalid.');
  }
  const raw = value as Partial<ManualDriveActionInfo>;
  if (
    typeof raw.action_id !== 'string' ||
    !raw.action_id.trim() ||
    typeof raw.kind !== 'string' ||
    !BRIDGE_ACTION_KINDS.has(raw.kind) ||
    typeof raw.title !== 'string' ||
    !raw.title.trim() ||
    !['ready', 'awaiting_approval', 'blocked'].includes(raw.status)
  ) {
    throw new Error('[MANUAL_DRIVE_BRIDGE_CORRUPT] action info shape is invalid.');
  }
  if (
    (raw.description !== undefined && typeof raw.description !== 'string') ||
    (raw.operation_id !== undefined && typeof raw.operation_id !== 'string') ||
    (raw.requires_approval !== undefined && typeof raw.requires_approval !== 'boolean')
  ) {
    throw new Error('[MANUAL_DRIVE_BRIDGE_CORRUPT] action info optional fields are invalid.');
  }
  const approval = raw.approval;
  if (
    approval !== undefined &&
    (!['approved', 'pending', 'denied'].includes(approval.status) ||
      (approval.request_id !== undefined && typeof approval.request_id !== 'string') ||
      (approval.message !== undefined && typeof approval.message !== 'string'))
  ) {
    throw new Error('[MANUAL_DRIVE_BRIDGE_CORRUPT] action approval shape is invalid.');
  }
  return {
    action_id: raw.action_id.trim(),
    kind: raw.kind as ManualDriveActionInfo['kind'],
    title: raw.title.trim(),
    ...(raw.description?.trim() ? { description: raw.description.trim() } : {}),
    ...(raw.operation_id?.trim() ? { operation_id: raw.operation_id.trim() } : {}),
    ...(raw.requires_approval !== undefined ? { requires_approval: raw.requires_approval } : {}),
    status: raw.status,
    ...(approval
      ? {
          approval: {
            status: approval.status,
            ...(approval.request_id?.trim() ? { request_id: approval.request_id.trim() } : {}),
            ...(approval.message?.trim() ? { message: approval.message.trim() } : {}),
          },
        }
      : {}),
  };
}

function descriptorFromUnknown(value: unknown, agentId: string): DurableManualDriverDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('[MANUAL_DRIVE_BRIDGE_CORRUPT] descriptor is not an object.');
  }
  const descriptor = value as Partial<DurableManualDriverDescriptor>;
  const action =
    descriptor.action === null || descriptor.action === undefined
      ? null
      : projectBridgeActionInfo(descriptor.action);
  if (
    descriptor.version !== 1 ||
    descriptor.agent_id !== agentId ||
    typeof descriptor.owner_id !== 'string' ||
    !descriptor.owner_id.trim() ||
    typeof descriptor.updated_at !== 'string' ||
    typeof descriptor.expires_at !== 'string' ||
    descriptor.status !== 'online' ||
    !descriptor.scope ||
    descriptor.action === undefined ||
    (descriptor.action !== null &&
      descriptor.action !== undefined &&
      typeof descriptor.action !== 'object') ||
    (descriptor.action !== null && descriptor.action !== undefined && action === null)
  ) {
    throw new Error('[MANUAL_DRIVE_BRIDGE_CORRUPT] descriptor shape is invalid.');
  }
  return {
    version: 1,
    agent_id: agentId,
    owner_id: descriptor.owner_id,
    scope: normalizeEventScope(descriptor.scope),
    status: 'online',
    updated_at: descriptor.updated_at,
    expires_at: descriptor.expires_at,
    action,
  };
}

export function readManualDriverDescriptor(agentId: string): DurableManualDriverDescriptor | null {
  const normalized = normalizeAgentId(agentId);
  const { descriptorPath } = bridgePaths(normalized);
  if (!safeExistsSync(descriptorPath)) return null;
  const descriptor = descriptorFromUnknown(readJsonIfPresent(descriptorPath), normalized);
  const updatedAt = Date.parse(descriptor.updated_at);
  const expiresAt = Date.parse(descriptor.expires_at);
  if (!Number.isFinite(updatedAt) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return null;
  }
  return descriptor;
}

function writeDescriptor(input: {
  agentId: string;
  ownerId: string;
  scope: EventScope;
  action: ManualDriveActionInfo | null;
}): void {
  const { descriptorPath } = bridgePaths(input.agentId);
  const action = projectBridgeActionInfo(input.action);
  const updatedAt = isoNow();
  safeWriteFile(
    descriptorPath,
    `${JSON.stringify({
      version: 1,
      agent_id: input.agentId,
      owner_id: input.ownerId,
      scope: input.scope,
      status: 'online',
      updated_at: updatedAt,
      expires_at: nowIso(new Date(Date.now() + DESCRIPTOR_TTL_MS)),
      action,
    } satisfies DurableManualDriverDescriptor)}\n`
  );
}

function readCommands(agentId: string): ManualDriverCommandRecord[] {
  const { commandPath } = bridgePaths(agentId);
  return readJsonLines<ManualDriverCommandRecord>(commandPath, {
    map: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('[MANUAL_DRIVE_BRIDGE_CORRUPT] command record is not an object.');
      }
      const raw = value as Partial<ManualDriverCommandRecord>;
      if (
        raw.agent_id !== agentId ||
        typeof raw.command_id !== 'string' ||
        !raw.command_id.trim() ||
        typeof raw.action_id !== 'string' ||
        !raw.action_id.trim() ||
        typeof raw.requested_at !== 'string' ||
        !raw.requested_at.trim() ||
        typeof raw.requested_by !== 'string' ||
        !raw.requested_by.trim() ||
        (raw.resumes_command_id !== undefined &&
          (typeof raw.resumes_command_id !== 'string' || !raw.resumes_command_id.trim()))
      ) {
        throw new Error('[MANUAL_DRIVE_BRIDGE_CORRUPT] command record shape is invalid.');
      }
      return {
        command_id: raw.command_id.trim(),
        agent_id: agentId,
        action_id: raw.action_id.trim(),
        requested_at: raw.requested_at,
        requested_by: raw.requested_by.trim(),
        ...(typeof raw.resumes_command_id === 'string' && raw.resumes_command_id.trim()
          ? { resumes_command_id: raw.resumes_command_id.trim() }
          : {}),
      };
    },
    onMalformed: (error, lineNumber) => {
      throw new Error(
        `[MANUAL_DRIVE_BRIDGE_CORRUPT] command line ${lineNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    },
  });
}

function readResultRecords(agentId: string): ManualDriverCommandResultRecord[] {
  const { resultPath } = bridgePaths(agentId);
  return readJsonLines<ManualDriverCommandResultRecord>(resultPath, {
    map: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('[MANUAL_DRIVE_BRIDGE_CORRUPT] result record is not an object.');
      }
      const raw = value as Partial<ManualDriverCommandResultRecord>;
      if (
        typeof raw.command_id !== 'string' ||
        raw.agent_id !== agentId ||
        typeof raw.action_id !== 'string' ||
        !['started', 'completed'].includes(raw.phase) ||
        typeof raw.recorded_at !== 'string' ||
        !raw.command_id.trim() ||
        !raw.action_id.trim() ||
        !raw.recorded_at.trim()
      ) {
        throw new Error('[MANUAL_DRIVE_BRIDGE_CORRUPT] result record shape is invalid.');
      }
      if (
        raw.status !== undefined &&
        !['executed', 'awaiting_approval', 'blocked', 'failed', 'idle'].includes(raw.status)
      ) {
        throw new Error('[MANUAL_DRIVE_BRIDGE_CORRUPT] result status is invalid.');
      }
      if (raw.error_code !== undefined && raw.error_code !== 'manual_drive_command_failed') {
        throw new Error('[MANUAL_DRIVE_BRIDGE_CORRUPT] result error code is invalid.');
      }
      const action = raw.action === undefined ? undefined : projectBridgeActionInfo(raw.action);
      const approval = raw.approval === undefined ? undefined : safeApproval(raw.approval);
      return {
        command_id: raw.command_id,
        agent_id: raw.agent_id,
        action_id: raw.action_id,
        phase: raw.phase,
        recorded_at: raw.recorded_at,
        ...(raw.status ? { status: raw.status } : {}),
        ...(action ? { action } : {}),
        ...(approval ? { approval } : {}),
        ...(raw.error_code ? { error_code: raw.error_code } : {}),
      };
    },
    onMalformed: (error, lineNumber) => {
      throw new Error(
        `[MANUAL_DRIVE_BRIDGE_CORRUPT] result line ${lineNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    },
  });
}

interface ManualDriverCommandCancellationRecord {
  command_id: string;
  agent_id: string;
  cancelled_at: string;
  cancelled_by: string;
}

function readCancellationRecords(agentId: string): ManualDriverCommandCancellationRecord[] {
  const { cancellationPath } = bridgePaths(agentId);
  return readJsonLines<ManualDriverCommandCancellationRecord>(cancellationPath, {
    map: (value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('[MANUAL_DRIVE_BRIDGE_CORRUPT] cancellation record is not an object.');
      }
      const raw = value as Partial<ManualDriverCommandCancellationRecord>;
      if (
        raw.agent_id !== agentId ||
        typeof raw.command_id !== 'string' ||
        !raw.command_id.trim() ||
        typeof raw.cancelled_at !== 'string' ||
        !raw.cancelled_at.trim() ||
        typeof raw.cancelled_by !== 'string' ||
        !raw.cancelled_by.trim()
      ) {
        throw new Error('[MANUAL_DRIVE_BRIDGE_CORRUPT] cancellation record shape is invalid.');
      }
      return {
        command_id: raw.command_id.trim(),
        agent_id: agentId,
        cancelled_at: raw.cancelled_at,
        cancelled_by: raw.cancelled_by.trim(),
      };
    },
    onMalformed: (error, lineNumber) => {
      throw new Error(
        `[MANUAL_DRIVE_BRIDGE_CORRUPT] cancellation line ${lineNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    },
  });
}

function safeApproval(value: unknown): ManualDriveApprovalDecision | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<ManualDriveApprovalDecision>;
  if (
    !['approved', 'pending', 'denied'].includes(raw.status) ||
    (raw.request_id !== undefined && typeof raw.request_id !== 'string') ||
    (raw.message !== undefined && typeof raw.message !== 'string')
  ) {
    return undefined;
  }
  return {
    status: raw.status,
    ...(raw.request_id?.trim() ? { request_id: raw.request_id.trim() } : {}),
    ...(raw.message?.trim() ? { message: raw.message.trim() } : {}),
  };
}

function latestResults(agentId: string): Map<string, ManualDriverCommandResultRecord> {
  const latest = new Map<string, ManualDriverCommandResultRecord>();
  for (const record of readResultRecords(agentId)) latest.set(record.command_id, record);
  return latest;
}

function safeExecutionResult(
  command: ManualDriverCommandRecord,
  result: ManualDriveExecutionResult
): ManualDriverCommandResultRecord {
  const action = result.action === undefined ? undefined : projectBridgeActionInfo(result.action);
  const status: ManualDriveExecutionStatus = [
    'executed',
    'awaiting_approval',
    'blocked',
    'failed',
    'idle',
  ].includes(result.status)
    ? result.status
    : 'failed';
  return {
    command_id: command.command_id,
    agent_id: command.agent_id,
    action_id: command.action_id,
    phase: 'completed',
    recorded_at: isoNow(),
    status,
    ...(action ? { action } : {}),
    ...(result.approval
      ? (() => {
          const approval = safeApproval(result.approval);
          return approval ? { approval } : {};
        })()
      : {}),
    ...(status === 'failed' ? { error_code: 'manual_drive_command_failed' } : {}),
  };
}

async function appendResult(
  record: ManualDriverCommandResultRecord,
  lockId: string
): Promise<void> {
  await withLock(lockId, async () => {
    ensureBridgeRoot();
    appendJsonLine(bridgePaths(record.agent_id).resultPath, record);
  });
}

async function processPendingCommands(input: {
  agentId: string;
  driver: AgentRuntimeManualDriver;
  lockId: string;
}): Promise<void> {
  for (const command of readCommands(input.agentId)) {
    const claimed = await withLock(input.lockId, async () => {
      const results = latestResults(input.agentId);
      const cancelled = new Set(
        readCancellationRecords(input.agentId).map((record) => record.command_id)
      );
      if (results.has(command.command_id) || cancelled.has(command.command_id)) return false;

      // Mark started before invoking the local executor. If the process dies
      // during an external effect, a later process will not duplicate it.
      ensureBridgeRoot();
      appendJsonLine(bridgePaths(command.agent_id).resultPath, {
        command_id: command.command_id,
        agent_id: command.agent_id,
        action_id: command.action_id,
        phase: 'started',
        recorded_at: isoNow(),
      } satisfies ManualDriverCommandResultRecord);
      return true;
    });
    if (!claimed) continue;
    try {
      const result = await input.driver.executeAction(command.action_id);
      await appendResult(safeExecutionResult(command, result), input.lockId);
    } catch {
      await appendResult(safeExecutionResult(command, { status: 'failed' }), input.lockId);
    }
  }
}

/** Start the supervisor-side poll/heartbeat loop for one local driver. */
export function startManualDriverBridge(input: ManualDriverBridgeOptions): () => void {
  const agentId = normalizeAgentId(input.agentId);
  const scope = normalizeEventScope(input.scope);
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10) {
    throw new Error('[MANUAL_DRIVE_BRIDGE] pollIntervalMs must be an integer >= 10');
  }
  ensureBridgeRoot();
  const ownerId = randomUUID();
  const { lockId, descriptorPath } = bridgePaths(agentId);
  withLockSync(lockId, () => {
    if (readManualDriverDescriptor(agentId)) {
      throw new Error(
        `[MANUAL_DRIVE_BRIDGE_ACTIVE] agent '${agentId}' already has an active bridge.`
      );
    }
    writeDescriptor({ agentId, ownerId, scope, action: null });
  });
  let stopped = false;
  let inFlight = false;

  const sync = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const action = await input.driver.peekAction();
      writeDescriptor({ agentId, ownerId, scope, action });
      await processPendingCommands({ agentId, driver: input.driver, lockId });
      const afterAction = await input.driver.peekAction();
      writeDescriptor({ agentId, ownerId, scope, action: afterAction });
    } finally {
      inFlight = false;
    }
  };

  void sync().catch(() => undefined);
  const timer = setInterval(() => {
    void sync().catch(() => undefined);
  }, pollIntervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
    try {
      withLockSync(lockId, () => {
        const current = readJsonIfPresent<DurableManualDriverDescriptor>(descriptorPath);
        if (current?.owner_id === ownerId) safeRmSync(descriptorPath, { force: true });
      });
    } catch {
      /* stale bridge metadata is bounded by descriptor expiry */
    }
  };
}

export async function enqueueManualDriverCommand(input: {
  agentId: string;
  actionId: string;
  requestedBy: string;
}): Promise<ManualDriverCommandReceipt> {
  const agentId = normalizeAgentId(input.agentId);
  const actionId = input.actionId.trim();
  const requestedBy = input.requestedBy.trim();
  if (!actionId) throw new Error('[MANUAL_DRIVE_BRIDGE] actionId is required');
  if (!requestedBy) throw new Error('[MANUAL_DRIVE_BRIDGE] requestedBy is required');
  const command: ManualDriverCommandRecord = {
    command_id: randomUUID(),
    agent_id: agentId,
    action_id: actionId,
    requested_at: isoNow(),
    requested_by: requestedBy,
  };
  const { commandPath, lockId } = bridgePaths(agentId);
  await withLock(lockId, async () => {
    ensureBridgeRoot();
    appendJsonLine(commandPath, command);
  });
  return {
    commandId: command.command_id,
    agentId,
    actionId,
    requestedAt: command.requested_at,
  };
}

/**
 * Requeue only a command whose first attempt stopped at the approval gate.
 * The worker keeps the pending action in memory; the gate is still evaluated
 * again when the resumed command is consumed, so this helper never grants an
 * approval or bypasses the action-id binding.
 */
export async function resumeManualDriverCommand(input: {
  agentId: string;
  commandId: string;
  resumedBy: string;
}): Promise<ManualDriverCommandReceipt> {
  const agentId = normalizeAgentId(input.agentId);
  const commandId = input.commandId.trim();
  const resumedBy = input.resumedBy.trim();
  if (!commandId) throw new Error('[MANUAL_DRIVE_BRIDGE] commandId is required');
  if (!resumedBy) throw new Error('[MANUAL_DRIVE_BRIDGE] resumedBy is required');
  const { commandPath, lockId } = bridgePaths(agentId);
  return withLock(lockId, async () => {
    const command = readCommands(agentId).find((entry) => entry.command_id === commandId);
    if (!command) throw new Error('[MANUAL_DRIVE_COMMAND_NOT_FOUND] command was not found.');
    if (command.resumes_command_id) {
      throw new Error('[MANUAL_DRIVE_COMMAND_INVALID_RESUME] a resumed command cannot be resumed.');
    }
    if (readCommands(agentId).some((entry) => entry.resumes_command_id === command.command_id)) {
      throw new Error('[MANUAL_DRIVE_COMMAND_ALREADY_RESUMED] command was already resumed.');
    }
    const results = latestResults(agentId);
    const result = results.get(commandId);
    if (!result || result.phase !== 'completed') {
      throw new Error(
        '[MANUAL_DRIVE_COMMAND_NOT_READY] command has not reached an approval result.'
      );
    }
    if (result.status !== 'awaiting_approval') {
      throw new Error(
        `[MANUAL_DRIVE_COMMAND_NOT_APPROVAL] command status is ${result.status || 'unknown'}.`
      );
    }
    if (readCancellationRecords(agentId).some((entry) => entry.command_id === commandId)) {
      throw new Error('[MANUAL_DRIVE_COMMAND_CANCELLED] command was cancelled.');
    }

    const resumed: ManualDriverCommandRecord = {
      command_id: randomUUID(),
      agent_id: agentId,
      action_id: command.action_id,
      requested_at: isoNow(),
      requested_by: resumedBy,
      resumes_command_id: command.command_id,
    };
    ensureBridgeRoot();
    appendJsonLine(commandPath, resumed);
    return {
      commandId: resumed.command_id,
      agentId,
      actionId: resumed.action_id,
      requestedAt: resumed.requested_at,
      resumesCommandId: resumed.resumes_command_id,
    };
  });
}

export type ManualDriverCommandCancelResult =
  'cancelled' | 'already_running' | 'already_completed' | 'already_cleared';

/** Cancel a durable command only while it is still pending. */
export async function cancelManualDriverCommand(input: {
  agentId: string;
  commandId: string;
  cancelledBy: string;
}): Promise<ManualDriverCommandCancelResult> {
  const agentId = normalizeAgentId(input.agentId);
  const commandId = input.commandId.trim();
  const cancelledBy = input.cancelledBy.trim();
  if (!commandId) throw new Error('[MANUAL_DRIVE_BRIDGE] commandId is required');
  if (!cancelledBy) throw new Error('[MANUAL_DRIVE_BRIDGE] cancelledBy is required');
  const { cancellationPath, lockId } = bridgePaths(agentId);
  return withLock(lockId, async () => {
    const command = readCommands(agentId).find((entry) => entry.command_id === commandId);
    if (!command) return 'already_cleared';
    const result = latestResults(agentId).get(commandId);
    if (result?.phase === 'started') return 'already_running';
    if (result?.phase === 'completed') return 'already_completed';
    if (readCancellationRecords(agentId).some((entry) => entry.command_id === commandId)) {
      return 'already_cleared';
    }
    ensureBridgeRoot();
    appendJsonLine(cancellationPath, {
      command_id: commandId,
      agent_id: agentId,
      cancelled_at: isoNow(),
      cancelled_by: cancelledBy,
    } satisfies ManualDriverCommandCancellationRecord);
    return 'cancelled';
  });
}

export function readManualDriverCommandStatus(
  agentId: string,
  commandId: string
): ManualDriverCommandStatus | null {
  const normalizedAgentId = normalizeAgentId(agentId);
  const normalizedCommandId = commandId.trim();
  if (!normalizedCommandId) return null;
  const record = latestResults(normalizedAgentId).get(normalizedCommandId);
  if (!record) {
    const command = readCommands(normalizedAgentId).find(
      (entry) => entry.command_id === normalizedCommandId
    );
    if (!command) return null;
    if (
      readCancellationRecords(normalizedAgentId).some(
        (entry) => entry.command_id === normalizedCommandId
      )
    ) {
      return {
        commandId: command.command_id,
        agentId: normalizedAgentId,
        actionId: command.action_id,
        state: 'cancelled',
        ...(command.resumes_command_id ? { resumesCommandId: command.resumes_command_id } : {}),
      };
    }
    return {
      commandId: command.command_id,
      agentId: normalizedAgentId,
      actionId: command.action_id,
      state: 'queued',
      ...(command.resumes_command_id ? { resumesCommandId: command.resumes_command_id } : {}),
    };
  }
  const command = readCommands(normalizedAgentId).find(
    (entry) => entry.command_id === record.command_id
  );
  return {
    commandId: record.command_id,
    agentId: normalizedAgentId,
    actionId: record.action_id,
    state: record.phase === 'started' ? 'running' : 'completed',
    ...(record.status ? { status: record.status } : {}),
    ...(record.action ? { action: record.action } : {}),
    ...(record.approval ? { approval: record.approval } : {}),
    ...(record.error_code ? { errorCode: record.error_code } : {}),
    ...(command?.resumes_command_id ? { resumesCommandId: command.resumes_command_id } : {}),
  };
}
