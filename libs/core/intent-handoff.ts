import * as path from 'node:path';
import { sharedTmp } from './path-resolver.js';
import { logger } from './core.js';
import { readJson } from './foundation/json.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';

/**
 * IL-01: carries the interpreted user intent (source utterance + agreed goal)
 * across the surface → mission promotion seam, so the mission's outcome
 * contract reflects the real request instead of a generic placeholder.
 *
 * The payload can contain confidential utterances, so it is written under the
 * governed shared tmp tier and deleted as soon as the mission consumes it.
 */

export interface IntentGoalHandoff {
  source_text?: string;
  correlation_id?: string;
  origin_intent_id?: string;
  origin_utterance_ref?: string;
  goal?: {
    summary?: string;
    success_condition?: string;
  };
  outcome_ids?: string[];
}

const HANDOFF_SUBDIR = 'intent-handoff';

export function writeIntentGoalHandoff(missionId: string, payload: IntentGoalHandoff): string {
  const normalizedMissionId = String(missionId || '').trim();
  if (
    !normalizedMissionId ||
    normalizedMissionId === '.' ||
    normalizedMissionId === '..' ||
    /[\\/]/u.test(normalizedMissionId)
  ) {
    throw new Error('intent handoff missionId must be a single safe path segment');
  }
  const fileName = `${normalizedMissionId}-${Date.now().toString(36)}.json`;
  const handoffPath = assertSafeRepositoryPath(sharedTmp(path.join(HANDOFF_SUBDIR, fileName)), {
    allowMissingLeaf: true,
  });
  safeWriteFile(handoffPath, JSON.stringify(payload, null, 2));
  return handoffPath;
}

/**
 * Read and delete a handoff file. Returns null (never throws) when the file
 * is missing or malformed — goal threading must not block mission creation.
 */
export function consumeIntentGoalHandoff(handoffPath: string): IntentGoalHandoff | null {
  try {
    const safeHandoffPath = assertSafeRepositoryPath(handoffPath, { allowMissingLeaf: true });
    if (!safeExistsSync(safeHandoffPath)) return null;
    const parsed = readJson<IntentGoalHandoff>(safeHandoffPath);
    try {
      safeUnlinkSync(safeHandoffPath);
    } catch {
      // Deletion failure is non-fatal; the janitor's tmp TTL is the backstop.
    }
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[intent-handoff] failed to consume ${handoffPath}: ${message}`);
    return null;
  }
}
