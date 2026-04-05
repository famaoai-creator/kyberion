import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

export type StandardIntentDefinition = {
  id?: string;
  category?: string;
  description?: string;
  surface_examples?: string[];
  trigger_keywords?: string[];
  resolution?: {
    shape?: string;
    task_kind?: string;
    result_shape?: string;
  };
};

export interface IntentResolutionCandidate {
  intent_id: string;
  confidence: number;
  source: 'catalog' | 'heuristic' | 'legacy';
  matched_keywords: string[];
  reasons: string[];
  resolution?: {
    shape?: string;
    task_kind?: string;
    result_shape?: string;
  };
}

export interface IntentResolutionPacket {
  kind: 'intent_resolution_packet';
  utterance: string;
  selected_intent_id?: string;
  selected_confidence?: number;
  selected_resolution?: {
    shape?: string;
    task_kind?: string;
    result_shape?: string;
  };
  candidates: IntentResolutionCandidate[];
}

let standardIntentCache: StandardIntentDefinition[] | null = null;

export function loadStandardIntentCatalog(): StandardIntentDefinition[] {
  if (standardIntentCache) return standardIntentCache;
  const filePath = pathResolver.knowledge('public/governance/standard-intents.json');
  const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as { intents?: StandardIntentDefinition[] };
  standardIntentCache = Array.isArray(parsed.intents) ? parsed.intents : [];
  return standardIntentCache;
}

function normalizeFreeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeFreeText(value)
    .split(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function scoreCatalogIntent(utterance: string, intent: StandardIntentDefinition): IntentResolutionCandidate | null {
  const normalized = normalizeFreeText(utterance);
  const matchedKeywords = (intent.trigger_keywords || []).filter((keyword) => normalized.includes(String(keyword).toLowerCase()));
  const reasons: string[] = [];
  let score = 0;

  if (intent.id && (intent.id === utterance || intent.id === normalized)) {
    score = 1.0;
    reasons.push('exact intent id match');
  }

  if (matchedKeywords.length > 0) {
    score = Math.max(score, Math.min(0.55 + matchedKeywords.length * 0.12, 0.92));
    reasons.push(`matched keywords: ${matchedKeywords.join(', ')}`);
  }

  const utteranceTokens = tokenize(utterance);
  const exactExample = (intent.surface_examples || []).find((example) => normalizeFreeText(example) === normalized);
  if (exactExample) {
    score = Math.max(score, 0.98);
    reasons.push(`exact surface example match: ${exactExample}`);
  }

  const containingExample = (intent.surface_examples || []).find((example) => {
    const normalizedExample = normalizeFreeText(example);
    return normalizedExample.length >= 4 && (normalized.includes(normalizedExample) || normalizedExample.includes(normalized));
  });
  if (containingExample) {
    score = Math.max(score, 0.84);
    reasons.push(`surface example containment: ${containingExample}`);
  }

  const exampleTokens = (intent.surface_examples || []).flatMap((example) => tokenize(example));
  const overlap = utteranceTokens.filter((token) => exampleTokens.includes(token));
  if (overlap.length > 0) {
    score = Math.max(score, Math.min(score + overlap.length * 0.03, 0.95));
    reasons.push(`surface example overlap: ${overlap.slice(0, 4).join(', ')}`);
  }

  if (score <= 0 || !intent.id) return null;
  return {
    intent_id: intent.id,
    confidence: Number(score.toFixed(2)),
    source: matchedKeywords.length > 0 ? 'heuristic' : 'catalog',
    matched_keywords: matchedKeywords,
    reasons,
    resolution: intent.resolution,
  };
}

function buildLegacyCandidates(utterance: string): IntentResolutionCandidate[] {
  const candidates: IntentResolutionCandidate[] = [];

  if (/(写真|撮影|photo|picture|camera)/i.test(utterance)) {
    candidates.push({
      intent_id: 'capture-photo',
      confidence: 0.88,
      source: 'legacy',
      matched_keywords: [],
      reasons: ['legacy capture-photo heuristic'],
      resolution: {
        shape: 'task_session',
        task_kind: 'capture_photo',
        result_shape: 'artifact',
      },
    });
  }

  if (/(再起動|restart|起動して|起動|stop|停止して|停止|status|状態|ログ|logs?)/i.test(utterance)) {
    candidates.push({
      intent_id: 'inspect-service',
      confidence: 0.86,
      source: 'heuristic',
      matched_keywords: [],
      reasons: ['service operation heuristic'],
      resolution: {
        shape: 'task_session',
        task_kind: 'service_operation',
        result_shape: 'summary',
      },
    });
  }

  return candidates;
}

export function resolveIntentResolutionPacket(utterance: string): IntentResolutionPacket {
  const trimmed = utterance.trim();
  const surfaceIntents = loadStandardIntentCatalog().filter((intent) => intent.category === 'surface');
  const candidates = [
    ...surfaceIntents
      .map((intent) => scoreCatalogIntent(trimmed, intent))
      .filter((candidate): candidate is IntentResolutionCandidate => Boolean(candidate)),
    ...buildLegacyCandidates(trimmed),
  ];

  const deduped = new Map<string, IntentResolutionCandidate>();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.intent_id);
    if (!existing || existing.confidence < candidate.confidence) {
      deduped.set(candidate.intent_id, candidate);
    }
  }

  const sorted = [...deduped.values()].sort((left, right) => right.confidence - left.confidence);
  const selected = sorted[0] && sorted[0].confidence >= 0.45 ? sorted[0] : undefined;

  return {
    kind: 'intent_resolution_packet',
    utterance: trimmed,
    selected_intent_id: selected?.intent_id,
    selected_confidence: selected?.confidence,
    selected_resolution: selected?.resolution,
    candidates: sorted,
  };
}
