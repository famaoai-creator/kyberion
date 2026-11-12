import { appendJsonLine } from '../foundation/json.js';
import { isRecord, readTextFile } from '../foundation/text.js';
import { nowIso } from '../foundation/time.js';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { withExecutionContext } from '../authority.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeMoveSync,
  safeRmSync,
} from '../secure-io.js';
import { resolveMissionDir } from '../governance/owner-scope.js';

/**
 * Append-only record of what the mission owner told its workers (handoffs,
 * review requests). It is NOT a delivery path: workers receive their task
 * through the agent execution port, and nothing reads this record back at
 * runtime or acknowledges rows in it. Single-owner missions keep a hub-and-spoke
 * shape; this file only makes the owner's side attributable.
 *
 * Stored at `<mission dir>/coordination/bus.jsonl` (the historical file name is
 * kept so existing missions stay readable).
 */

/**
 * Only `handoff` and `review` are written today. `task_contract` and
 * `runtime_notice` stay in the vocabulary because ledgers written by earlier
 * versions may carry them and must still parse.
 */
export type MissionCoordinationChannel = 'task_contract' | 'handoff' | 'review' | 'runtime_notice';

export interface MissionCoordinationRecord {
  message_id: string;
  mission_id: string;
  channel: MissionCoordinationChannel;
  from_agent: string;
  from_role?: string;
  to_agent?: string;
  to_role?: string;
  correlation_id?: string;
  task_id?: string;
  content: string;
  created_at: string;
  /** Legacy field of the retired acknowledgement API; always written as `[]`. */
  acknowledged_by: string[];
}

const COORDINATION_CHANNELS: readonly MissionCoordinationChannel[] = [
  'task_contract',
  'handoff',
  'review',
  'runtime_notice',
];

function requiredString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredString(value);
}

function parseAcknowledgedBy(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.map(requiredString);
  return values.every((entry): entry is string => entry !== undefined) ? values : undefined;
}

function parseRecordBody(value: unknown): MissionCoordinationRecord | undefined {
  if (!isRecord(value)) return undefined;
  const messageId = requiredString(value.message_id);
  const missionId = requiredString(value.mission_id);
  const channel = value.channel;
  const normalizedChannel =
    typeof channel === 'string' &&
    COORDINATION_CHANNELS.includes(channel as MissionCoordinationChannel)
      ? (channel as MissionCoordinationChannel)
      : undefined;
  const fromAgent = requiredString(value.from_agent);
  const content = requiredString(value.content);
  const createdAt = requiredString(value.created_at);
  const acknowledgedBy = parseAcknowledgedBy(value.acknowledged_by);
  if (
    !messageId ||
    !missionId ||
    normalizedChannel === undefined ||
    !fromAgent ||
    !content ||
    !createdAt ||
    !Number.isFinite(Date.parse(createdAt)) ||
    !acknowledgedBy
  ) {
    return undefined;
  }
  const fromRole = optionalString(value.from_role);
  const toAgent = optionalString(value.to_agent);
  const toRole = optionalString(value.to_role);
  const correlationId = optionalString(value.correlation_id);
  const taskId = optionalString(value.task_id);
  if (
    (value.from_role !== undefined && !fromRole) ||
    (value.to_agent !== undefined && !toAgent) ||
    (value.to_role !== undefined && !toRole) ||
    (value.correlation_id !== undefined && !correlationId) ||
    (value.task_id !== undefined && !taskId)
  ) {
    return undefined;
  }
  return {
    message_id: messageId,
    mission_id: missionId,
    channel: normalizedChannel,
    from_agent: fromAgent,
    ...(fromRole ? { from_role: fromRole } : {}),
    ...(toAgent ? { to_agent: toAgent } : {}),
    ...(toRole ? { to_role: toRole } : {}),
    ...(correlationId ? { correlation_id: correlationId } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    content,
    created_at: createdAt,
    acknowledged_by: acknowledgedBy,
  };
}

/**
 * Parse one stored row. Returns the record for `{kind:'message'}` rows and bare
 * records; returns undefined for malformed rows and for the `{kind:'ack'}` rows
 * of the retired acknowledgement API (no current code writes them).
 */
export function parseMissionCoordinationRecordRow(
  value: unknown
): MissionCoordinationRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'ack') return undefined;
  if (value.kind === 'message') return parseRecordBody(value.message);
  return parseRecordBody(value);
}

const DEFAULT_MAX_LINES = 10_000;
const DEFAULT_ARCHIVE_COUNT = 5;

export interface MissionCoordinationRecordOptions {
  maxLinesPerFile?: number;
  maxArchiveCount?: number;
}

export interface MissionCoordinationRecordInput {
  mission_id: string;
  channel: MissionCoordinationChannel;
  from_agent: string;
  from_role?: string;
  to_agent?: string;
  to_role?: string;
  correlation_id?: string;
  task_id?: string;
  content: string;
}

function recordPath(missionId: string): string {
  // The record lives in the existing mission's own directory; an unknown
  // mission fails closed (OwnerScopeError) instead of landing in public.
  const missionPath = assertSafeRepositoryPath(resolveMissionDir(missionId), {
    allowMissingLeaf: true,
  });
  return assertSafeRepositoryPath(`${missionPath}/coordination/bus.jsonl`, {
    allowMissingLeaf: true,
  });
}

function archivePath(missionId: string, index: number): string {
  return assertSafeRepositoryPath(`${recordPath(missionId)}.${index}`, {
    allowMissingLeaf: true,
  });
}

function countLines(filePath: string): number {
  if (!safeExistsSync(filePath)) return 0;
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`[MISSION_COORDINATION_RESOURCE] stream must be a regular file: ${filePath}`);
  }
  const raw = String(readTextFile(filePath) || '');
  return raw.split(/\r?\n/u).filter((line) => line.trim()).length;
}

function rotate(missionId: string, maxArchiveCount: number): void {
  const currentPath = recordPath(missionId);
  if (!safeExistsSync(currentPath)) return;
  for (let index = maxArchiveCount; index >= 1; index -= 1) {
    const source = index === 1 ? currentPath : archivePath(missionId, index - 1);
    const destination = archivePath(missionId, index);
    if (!safeExistsSync(source)) continue;
    if (safeExistsSync(destination)) {
      safeRmSync(destination, { force: true });
    }
    safeMoveSync(source, destination);
  }
}

/** Append one owner-to-worker message to the mission's coordination record. */
export function recordMissionCoordinationMessage(
  input: MissionCoordinationRecordInput,
  options: MissionCoordinationRecordOptions = {}
): MissionCoordinationRecord {
  const maxLines =
    options.maxLinesPerFile && options.maxLinesPerFile > 0
      ? Math.floor(options.maxLinesPerFile)
      : DEFAULT_MAX_LINES;
  const maxArchive =
    options.maxArchiveCount && options.maxArchiveCount > 0
      ? Math.floor(options.maxArchiveCount)
      : DEFAULT_ARCHIVE_COUNT;
  const message: MissionCoordinationRecord = {
    message_id: `MCB-${randomUUID().slice(0, 8).toUpperCase()}`,
    mission_id: input.mission_id.toUpperCase(),
    channel: input.channel,
    from_agent: input.from_agent,
    from_role: input.from_role,
    to_agent: input.to_agent,
    to_role: input.to_role,
    correlation_id: input.correlation_id,
    task_id: input.task_id,
    content: input.content,
    created_at: nowIso(),
    acknowledged_by: [],
  };
  withExecutionContext('mission_controller', () => {
    const filePath = recordPath(message.mission_id);
    safeMkdir(path.dirname(filePath));
    if (countLines(filePath) >= maxLines) rotate(message.mission_id, maxArchive);
    appendJsonLine(filePath, { kind: 'message', message });
  });
  return message;
}
