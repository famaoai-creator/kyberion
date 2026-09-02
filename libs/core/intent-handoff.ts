import * as path from 'node:path';
import { sharedTmp } from './path-resolver.js';
import { logger } from './core.js';
import { readJson } from './foundation/json.js';
import { parseSafeJsonObjectValue } from './foundation/safe-json.js';
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

const HANDOFF_FIELDS = [
  'source_text',
  'correlation_id',
  'origin_intent_id',
  'origin_utterance_ref',
  'goal',
  'outcome_ids',
] as const;

function optionalHandoffText(
  record: Record<string, unknown>,
  key: string
): string | undefined | null {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function parseIntentGoalHandoff(value: unknown): IntentGoalHandoff | null {
  let record: Record<string, unknown>;
  try {
    record = parseSafeJsonObjectValue(value, 'intent goal handoff');
  } catch {
    return null;
  }
  if (
    Object.keys(record).some(
      (key) => !HANDOFF_FIELDS.includes(key as (typeof HANDOFF_FIELDS)[number])
    )
  ) {
    return null;
  }

  const sourceText = optionalHandoffText(record, 'source_text');
  const correlationId = optionalHandoffText(record, 'correlation_id');
  const originIntentId = optionalHandoffText(record, 'origin_intent_id');
  const originUtteranceRef = optionalHandoffText(record, 'origin_utterance_ref');
  if (
    sourceText === null ||
    correlationId === null ||
    originIntentId === null ||
    originUtteranceRef === null
  ) {
    return null;
  }

  let goal: IntentGoalHandoff['goal'];
  if (record.goal !== undefined) {
    let goalRecord: Record<string, unknown>;
    try {
      goalRecord = parseSafeJsonObjectValue(record.goal, 'intent goal handoff goal');
    } catch {
      return null;
    }
    if (!Object.keys(goalRecord).every((key) => key === 'summary' || key === 'success_condition')) {
      return null;
    }
    const summary = optionalHandoffText(goalRecord, 'summary');
    const successCondition = optionalHandoffText(goalRecord, 'success_condition');
    if (summary === null || successCondition === null) return null;
    goal = {
      ...(summary === undefined ? {} : { summary }),
      ...(successCondition === undefined ? {} : { success_condition: successCondition }),
    };
  }

  let outcomeIds: string[] | undefined;
  if (record.outcome_ids !== undefined) {
    if (
      !Array.isArray(record.outcome_ids) ||
      record.outcome_ids.some((entry) => typeof entry !== 'string' || !entry.trim())
    ) {
      return null;
    }
    outcomeIds = record.outcome_ids.map((entry) => entry.trim());
  }

  return {
    ...(sourceText === undefined ? {} : { source_text: sourceText }),
    ...(correlationId === undefined ? {} : { correlation_id: correlationId }),
    ...(originIntentId === undefined ? {} : { origin_intent_id: originIntentId }),
    ...(originUtteranceRef === undefined ? {} : { origin_utterance_ref: originUtteranceRef }),
    ...(goal === undefined ? {} : { goal }),
    ...(outcomeIds === undefined ? {} : { outcome_ids: outcomeIds }),
  };
}

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
  const parsedPayload = parseIntentGoalHandoff(payload);
  if (!parsedPayload) throw new Error('Invalid intent goal handoff payload');
  safeWriteFile(handoffPath, JSON.stringify(parsedPayload, null, 2));
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
    const parsed = parseIntentGoalHandoff(readJson<unknown>(safeHandoffPath));
    try {
      safeUnlinkSync(safeHandoffPath);
    } catch {
      // Deletion failure is non-fatal; the janitor's tmp TTL is the backstop.
    }
    return parsed;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[intent-handoff] failed to consume ${handoffPath}: ${message}`);
    return null;
  }
}
