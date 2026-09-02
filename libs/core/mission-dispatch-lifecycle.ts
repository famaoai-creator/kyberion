/**
 * Shared lifecycle helpers for mission ticket/workitem dispatch flows.
 */

import * as nodePath from 'node:path';
import { appendJsonLine, ensureDirectory, readJsonFile } from './mission-dispatch-io.js';
import { nowIso } from './foundation/time.js';
import { provisionMissionEntry, writeProvisionedJson } from './mission-orchestration-journal.js';

export function ensureDispatchTree(filePath: string): void {
  ensureDirectory(nodePath.dirname(filePath));
}

export function writeDispatchArtifact(
  filePath: string,
  payload: unknown,
  options: { missionId: string; missionPath: string }
): void {
  const missionId = options.missionId.trim();
  const missionPath = options.missionPath.trim();
  if (!missionId) throw new Error('[DISPATCH_ARTIFACT] missionId is required');
  if (!missionPath) throw new Error('[DISPATCH_ARTIFACT] missionPath is required');
  const targetPath = nodePath.relative(missionPath, filePath);
  if (!targetPath || targetPath === '..' || targetPath.startsWith(`..${nodePath.sep}`)) {
    throw new Error('[DISPATCH_ARTIFACT] artifact must be inside missionPath');
  }
  ensureDispatchTree(filePath);
  writeProvisionedJson({
    missionId,
    filePath,
    targetPath,
    missionPathHint: missionPath,
    provisioned: provisionMissionEntry(payload),
  });
}

export function appendDispatchEvent(filePath: string, entry: Record<string, unknown>): void {
  ensureDispatchTree(filePath);
  appendJsonLine(filePath, { ...entry, ts: nowIso() });
}

export function readDispatchRecord<T>(filePath: string): T | null {
  try {
    const parsed = readJsonFile<T>(filePath);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
