import { parseSafeJsonInput } from './foundation/safe-json.js';
import { isRecord } from './foundation/text.js';

export interface VadBridgeResponse {
  prob?: number;
  error?: string;
  ok?: boolean;
}

/** Normalize one response emitted by a VAD subprocess over NDJSON. */
export function normalizeVadBridgeResponse(value: unknown): VadBridgeResponse | null {
  if (!isRecord(value)) return null;

  const prob = value.prob;
  let normalizedProb: number | undefined;
  if (prob !== undefined) {
    if (typeof prob !== 'number' || !Number.isFinite(prob) || prob < 0 || prob > 1) {
      return null;
    }
    normalizedProb = prob;
  }

  const error = value.error;
  let normalizedError: string | undefined;
  if (error !== undefined) {
    if (typeof error !== 'string') return null;
    normalizedError = error;
  }

  const ok = value.ok;
  let normalizedOk: boolean | undefined;
  if (ok !== undefined) {
    if (typeof ok !== 'boolean') return null;
    normalizedOk = ok;
  }

  if (normalizedProb === undefined && normalizedError === undefined && normalizedOk === undefined) {
    return null;
  }

  return {
    ...(normalizedProb !== undefined ? { prob: normalizedProb } : {}),
    ...(normalizedError !== undefined ? { error: normalizedError } : {}),
    ...(normalizedOk !== undefined ? { ok: normalizedOk } : {}),
  };
}

/** Parse and normalize one non-empty VAD NDJSON line; malformed lines are ignored. */
export function parseVadBridgeLine(line: string): VadBridgeResponse | null {
  try {
    return normalizeVadBridgeResponse(parseSafeJsonInput(line, 'VAD bridge response'));
  } catch {
    return null;
  }
}
