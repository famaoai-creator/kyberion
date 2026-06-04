/**
 * Shared lifecycle helpers for mission ticket/workitem dispatch flows.
 */

import * as nodePath from 'node:path';
import {
  appendJsonLine,
  ensureDirectory,
  readJsonFile,
  writeJsonFile,
} from './mission-dispatch-io.js';

export function ensureDispatchTree(filePath: string): void {
  ensureDirectory(nodePath.dirname(filePath));
}

export function writeDispatchArtifact(filePath: string, payload: unknown): void {
  ensureDispatchTree(filePath);
  writeJsonFile(filePath, payload);
}

export function appendDispatchEvent(filePath: string, entry: Record<string, unknown>): void {
  ensureDispatchTree(filePath);
  appendJsonLine(filePath, { ...entry, ts: new Date().toISOString() });
}

export function readDispatchRecord<T>(filePath: string): T | null {
  try {
    const parsed = readJsonFile<T>(filePath);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
