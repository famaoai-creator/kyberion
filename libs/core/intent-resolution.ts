import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';
import { matchesAnyTextRule, type TextMatchRule } from './text-rule-matcher.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const STANDARD_INTENTS_SCHEMA_PATH = pathResolver.knowledge('public/schemas/standard-intents.schema.json');
const INTENT_RESOLUTION_POLICY_SCHEMA_PATH = pathResolver.knowledge('public/schemas/intent-resolution-policy.schema.json');

export type StandardIntentDefinition = {
  id?: string;
  category?: string;
  description?: string;
  surface_examples?: string[];
  trigger_keywords?: string[];
  outcome_ids?: string[];
  specialist_id?: string;
  plan_outline?: string[];
  intake_requirements?: string[];
  pipeline?: Array<{ op?: string; params?: Record<string, unknown> }>;
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

type CatalogScoringPolicy = {
  exact_intent_id_confidence: number;
  keyword_base_confidence: number;
  keyword_increment: number;
  keyword_max_confidence: number;
  exact_surface_example_confidence: number;
  surface_containment_confidence: number;
  surface_overlap_increment: number;
  surface_overlap_max_confidence: number;
  selected_confidence_threshold: number;
  catalog_intent_category: string;
};

type LegacyIntentResolutionCandidate = {
  id: string;
  intent_id: string;
  confidence: number;
  source: 'catalog' | 'heuristic' | 'legacy';
  reasons: string[];
  patterns: Array<TextMatchRule | string>;
  resolution: {
    shape?: string;
    task_kind?: string;
    result_shape?: string;
  };
};

type IntentResolutionPolicyFile = {
  version: string;
  catalog_scoring: CatalogScoringPolicy;
  legacy_candidates: LegacyIntentResolutionCandidate[];
};

let standardIntentCache: StandardIntentDefinition[] | null = null;
let standardIntentValidateFn: ValidateFunction | null = null;
let intentResolutionPolicyCache: IntentResolutionPolicyFile | null = null;
let intentResolutionPolicyValidateFn: ValidateFunction | null = null;

function ensureStandardIntentValidator(): ValidateFunction {
  if (standardIntentValidateFn) return standardIntentValidateFn;
  standardIntentValidateFn = compileSchemaFromPath(ajv, STANDARD_INTENTS_SCHEMA_PATH);
  return standardIntentValidateFn;
}

function ensureIntentResolutionPolicyValidator(): ValidateFunction {
  if (intentResolutionPolicyValidateFn) return intentResolutionPolicyValidateFn;
  intentResolutionPolicyValidateFn = compileSchemaFromPath(ajv, INTENT_RESOLUTION_POLICY_SCHEMA_PATH);
  return intentResolutionPolicyValidateFn;
}

export function loadStandardIntentCatalog(): StandardIntentDefinition[] {
  if (standardIntentCache) return standardIntentCache;
  const filePath = pathResolver.knowledge('public/governance/standard-intents.json');
  const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as { intents?: StandardIntentDefinition[] };
  const validate = ensureStandardIntentValidator();
  if (!validate(parsed)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid standard-intents catalog: ${errors}`);
  }
  standardIntentCache = Array.isArray(parsed.intents) ? parsed.intents : [];
  return standardIntentCache;
}

function loadIntentResolutionPolicy(): IntentResolutionPolicyFile {
  if (intentResolutionPolicyCache) return intentResolutionPolicyCache;
  const filePath = pathResolver.knowledge('public/governance/intent-resolution-policy.json');
  const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as IntentResolutionPolicyFile;
  const validate = ensureIntentResolutionPolicyValidator();
  if (!validate(parsed)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid intent-resolution-policy: ${errors}`);
  }
  intentResolutionPolicyCache = parsed;
  return intentResolutionPolicyCache;
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
  const policy = loadIntentResolutionPolicy().catalog_scoring;
  const normalized = normalizeFreeText(utterance);
  const matchedKeywords = (intent.trigger_keywords || []).filter((keyword) => normalized.includes(String(keyword).toLowerCase()));
  const reasons: string[] = [];
  let score = 0;

  if (intent.id && (intent.id === utterance || intent.id === normalized)) {
    score = policy.exact_intent_id_confidence;
    reasons.push('exact intent id match');
  }

  if (matchedKeywords.length > 0) {
    score = Math.max(score, Math.min(policy.keyword_base_confidence + matchedKeywords.length * policy.keyword_increment, policy.keyword_max_confidence));
    reasons.push(`matched keywords: ${matchedKeywords.join(', ')}`);
  }

  const utteranceTokens = tokenize(utterance);
  const exactExample = (intent.surface_examples || []).find((example) => normalizeFreeText(example) === normalized);
  if (exactExample) {
    score = Math.max(score, policy.exact_surface_example_confidence);
    reasons.push(`exact surface example match: ${exactExample}`);
  }

  const containingExample = (intent.surface_examples || []).find((example) => {
    const normalizedExample = normalizeFreeText(example);
    return normalizedExample.length >= 4 && (normalized.includes(normalizedExample) || normalizedExample.includes(normalized));
  });
  if (containingExample) {
    score = Math.max(score, policy.surface_containment_confidence);
    reasons.push(`surface example containment: ${containingExample}`);
  }

  const exampleTokens = (intent.surface_examples || []).flatMap((example) => tokenize(example));
  const overlap = utteranceTokens.filter((token) => exampleTokens.includes(token));
  if (overlap.length > 0) {
    score = Math.max(score, Math.min(score + overlap.length * policy.surface_overlap_increment, policy.surface_overlap_max_confidence));
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
  return loadIntentResolutionPolicy().legacy_candidates
    .filter((candidate) => matchesAnyTextRule(utterance, candidate.patterns))
    .map((candidate) => ({
      intent_id: candidate.intent_id,
      confidence: candidate.confidence,
      source: candidate.source,
      matched_keywords: [],
      reasons: candidate.reasons,
      resolution: candidate.resolution,
    }));
}

export function resolveIntentResolutionPacket(utterance: string): IntentResolutionPacket {
  const trimmed = utterance.trim();
  const scoringPolicy = loadIntentResolutionPolicy().catalog_scoring;
  const surfaceIntents = loadStandardIntentCatalog().filter((intent) => intent.category === scoringPolicy.catalog_intent_category);
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
  const selected = sorted[0] && sorted[0].confidence >= scoringPolicy.selected_confidence_threshold ? sorted[0] : undefined;

  return {
    kind: 'intent_resolution_packet',
    utterance: trimmed,
    selected_intent_id: selected?.intent_id,
    selected_confidence: selected?.confidence,
    selected_resolution: selected?.resolution,
    candidates: sorted,
  };
}
