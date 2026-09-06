import { isRecord } from '@agent/core/foundation/primitives';
import { parseKnowledgeCandidate, type ClientKnowledgeCandidate } from './knowledge-response';

export type KnowledgeMutationResponse = {
  ok: true;
  candidate: ClientKnowledgeCandidate;
};

export type KnowledgeFeedbackResponse = {
  ok: true;
  feedback_path: string;
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

export function parseKnowledgeMutationResponse(
  value: unknown
): KnowledgeMutationResponse | undefined {
  if (!isRecord(value) || !hasSafeTree(value) || value.ok !== true) return undefined;
  const candidate = parseKnowledgeCandidate(value.candidate);
  return candidate ? { ok: true, candidate } : undefined;
}

export function parseKnowledgeFeedbackResponse(
  value: unknown
): KnowledgeFeedbackResponse | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    value.ok !== true ||
    typeof value.feedback_path !== 'string' ||
    !value.feedback_path.trim()
  ) {
    return undefined;
  }
  return { ok: true, feedback_path: value.feedback_path };
}
