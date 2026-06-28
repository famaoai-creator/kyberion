import AjvModule, { type ValidateFunction } from 'ajv';
import { pathResolver } from './path-resolver.js';
import { compileSchemaFromPath } from './schema-loader.js';
import { safeReadFile } from './secure-io.js';
import { matchesAnyTextRule, type TextMatchRule } from './text-rule-matcher.js';
import {
  resolveCapabilityBundleForIntent,
  resolveCapabilityBundlesForUtterance,
} from './capability-bundle-registry.js';
import { buildContextualIntentFrame } from './contextual-intent-frame.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const STANDARD_INTENTS_SCHEMA_PATH = pathResolver.knowledge('product/schemas/standard-intents.schema.json');
const INTENT_RESOLUTION_POLICY_SCHEMA_PATH = pathResolver.knowledge('product/schemas/intent-resolution-policy.schema.json');

export type StandardIntentDefinition = {
  id?: string;
  category?: string;
  legacy_category?: string;
  exposed_to_surface?: boolean;
  target?: string;
  action?: string;
  object?: string;
  execution_shape?: string;
  mission_class?: string;
  risk_profile?: 'low' | 'review_required' | 'approval_required' | 'high_stakes';
  description?: string;
  surface_examples?: string[];
  trigger_keywords?: string[];
  outcome_ids?: string[];
  specialist_id?: string;
  execution_profile_id?: string;
  plan_outline?: string[];
  intake_requirements?: string[];
  pipeline?: Array<{ op?: string; params?: Record<string, unknown> }>;
  resolution?: {
    shape?: string;
    task_kind?: string;
    result_shape?: string;
  };
};

type IntentDomainOntologyEntry = {
  intent_id: string;
  exposed_to_surface?: boolean;
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

export interface IntentResolutionBundleCandidate {
  bundle_id: string;
  status: 'active' | 'experimental' | 'conceptual' | 'deprecated';
  kind: 'actuator-pipeline-bundle' | 'capability-bundle';
  summary: string;
  required_actuators: string[];
  intents: string[];
  references: string[];
}

export interface IntentResolutionSelectedParameters {
  platform_id?: string;
  target_platform?: string;
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
  selected_parameters?: IntentResolutionSelectedParameters;
  candidates: IntentResolutionCandidate[];
  bundle_candidates?: IntentResolutionBundleCandidate[];
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
let intentDomainOntologyCache: Map<string, IntentDomainOntologyEntry> | null = null;
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
  const filePath = pathResolver.knowledge('product/governance/standard-intents.json');
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
  const filePath = pathResolver.knowledge('product/governance/intent-resolution-policy.json');
  const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as IntentResolutionPolicyFile;
  const validate = ensureIntentResolutionPolicyValidator();
  if (!validate(parsed)) {
    const errors = (validate.errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid intent-resolution-policy: ${errors}`);
  }
  intentResolutionPolicyCache = parsed;
  return intentResolutionPolicyCache;
}

function loadIntentDomainOntology(): Map<string, IntentDomainOntologyEntry> {
  if (intentDomainOntologyCache) return intentDomainOntologyCache;
  const filePath = pathResolver.knowledge('product/governance/intent-domain-ontology.json');
  const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as {
    intents?: IntentDomainOntologyEntry[];
  };
  const mapped = new Map<string, IntentDomainOntologyEntry>();
  for (const entry of parsed.intents || []) {
    if (!entry.intent_id) continue;
    mapped.set(entry.intent_id, entry);
  }
  intentDomainOntologyCache = mapped;
  return intentDomainOntologyCache;
}

function normalizeFreeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim();
}

// Converts full-width ASCII (\uff21\u2013\uff3a, \uff10\u2013\uff19, \uff01 etc.) to half-width equivalents
// so "\uff21\uff29" resolves the same as "AI" in keyword matching.
function normalizeFullWidthToHalfWidth(text: string): string {
  return text.replace(/[\uff01-\uff5e]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  );
}

// Converts katakana to hiragana so "\u30b9\u30e9\u30c3\u30af" and "\u3059\u3089\u3063\u304f" both match "slack".
function normalizeKatakanaToHiragana(text: string): string {
  return text.replace(/[\u30a1-\u30f6]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0x60)
  );
}

/**
 * Locale-aware normalization for trigger matching.
 * Applies full-width\u2192half-width and katakana\u2192hiragana before standard text normalization,
 * so Japanese utterances match ASCII trigger keywords and vice versa.
 */
export function normalizeForTriggerMatch(utterance: string): string {
  return normalizeFreeText(normalizeKatakanaToHiragana(normalizeFullWidthToHalfWidth(utterance)));
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
  const localizedNormalized = normalizeForTriggerMatch(utterance);
  const matchedKeywords = (intent.trigger_keywords || []).filter((keyword) => {
    const kw = String(keyword).toLowerCase();
    return normalized.includes(kw) || localizedNormalized.includes(kw);
  });
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

function scoreScheduleReadAgendaIntent(utterance: string): IntentResolutionCandidate | null {
  const frame = buildContextualIntentFrame(utterance);
  const normalized = normalizeFreeText(utterance);
  const calendarHint = /(予定|スケジュール|日程|空き時間|会議|ミーティング|打ち合わせ|アポイント|agenda|availability|calendar)/i.test(normalized);
  const readHint = frame.action === 'read';
  if (!calendarHint || !readHint) return null;

  let confidence = 0.78;
  const reasons: string[] = ['read-only calendar agenda request'];
  if (frame.date_range) {
    confidence += 0.08;
    reasons.push(`date range resolved: ${frame.date_range.value}`);
  }
  if (frame.source_binding.selected) {
    confidence += 0.08;
    reasons.push(`source binding resolved: ${frame.source_binding.selected}`);
  }
  if (frame.subject === 'operator_self') {
    confidence += 0.04;
    reasons.push('subject inferred as operator self');
  }
  if (/(教えて|見せて|確認|見る|空き|show|see|check)/i.test(normalized)) {
    confidence += 0.04;
    reasons.push('read verb matched');
  }
  confidence = Math.min(0.97, confidence);

  return {
    intent_id: 'schedule-read-agenda',
    confidence: Number(confidence.toFixed(2)),
    source: 'heuristic',
    matched_keywords: [],
    reasons,
    resolution: {
      shape: 'direct_reply',
      result_shape: 'calendar_agenda_summary',
    },
  };
}

function scoreScheduleCoordinationIntent(utterance: string): IntentResolutionCandidate | null {
  const frame = buildContextualIntentFrame(utterance);
  const normalized = normalizeFreeText(utterance);
  const scheduleHint = /(予定|スケジュール|日程|空き時間|会議|ミーティング|打ち合わせ|アポイント|参加者|全員|合わせて|calendar|schedule)/i.test(
    normalized
  );
  const changeHint = frame.action === 'change';
  const meetingProxyHint = /(代わりに参加|代理参加|ファシリテート|進行|議事録|アクションアイテム|proxy|facilitate)/i.test(normalized);
  if (!scheduleHint || !changeHint || meetingProxyHint) return null;

  let confidence = 0.8;
  const reasons: string[] = ['schedule change request'];
  if (frame.date_range) {
    confidence += 0.05;
    reasons.push(`date range resolved: ${frame.date_range.value}`);
  }
  if (frame.source_binding.selected) {
    confidence += 0.05;
    reasons.push(`source binding resolved: ${frame.source_binding.selected}`);
  }
  if (frame.subject !== 'unknown') {
    confidence += 0.03;
    reasons.push(`subject inferred as ${frame.subject}`);
  }
  confidence = Math.min(0.97, confidence);

  return {
    intent_id: 'schedule-coordination',
    confidence: Number(confidence.toFixed(2)),
    source: 'heuristic',
    matched_keywords: [],
    reasons,
    resolution: {
      shape: 'task_session',
      task_kind: 'service_operation',
      result_shape: 'summary',
    },
  };
}

function scoreApprovalWorkflowIntent(utterance: string): IntentResolutionCandidate | null {
  const normalized = normalizeFreeText(utterance);
  const approvalHint = /(稟議|決裁|承認|approval|approve)/i.test(normalized);
  if (!approvalHint) return null;

  const requestHint = /(依頼|申請|お願い|作成|request|create)/i.test(normalized);
  const resolveHint = /(決裁|承認して|承認し|approveして|approve|処理して|通して|通しといて)/i.test(
    normalized
  );

  const reasons: string[] = ['approval workflow request'];
  let intentId = 'resolve-approval';
  let confidence = 0.82;
  let resultShape = 'summary';
  if (requestHint && !resolveHint) {
    intentId = 'request-approval';
    confidence = 0.8;
    reasons.push('approval request phrasing matched');
  } else {
    reasons.push('approval resolution phrasing matched');
  }
  if (/(稟議|決裁)/i.test(normalized)) {
    confidence += 0.08;
    reasons.push('ringi vocabulary matched');
  }
  if (/(システム|一覧|案件|申請|ワークフロー|workflow|system)/i.test(normalized)) {
    confidence += 0.04;
    reasons.push('workflow/system context matched');
  }

  return {
    intent_id: intentId,
    confidence: Number(Math.min(0.97, confidence).toFixed(2)),
    source: 'heuristic',
    matched_keywords: [],
    reasons,
    resolution: {
      shape: 'task_session',
      task_kind: 'service_operation',
      result_shape: resultShape,
    },
  };
}

function scoreVoiceInputIntent(utterance: string): IntentResolutionCandidate | null {
  const normalized = normalizeFreeText(utterance);
  const voiceInputHint = /(音声入力|dictation|voice input|入力モード|マイク入力)/i.test(normalized);
  if (!voiceInputHint) return null;

  let confidence = 0.84;
  const reasons: string[] = ['voice input toggle request'];
  if (/(音声入力|dictation)/i.test(normalized)) {
    confidence += 0.08;
    reasons.push('voice input vocabulary matched');
  }
  if (/(オン|on|enable|有効)/i.test(normalized)) {
    confidence += 0.03;
    reasons.push('enable phrasing matched');
  }
  confidence = Math.min(0.97, confidence);

  return {
    intent_id: 'enable-voice-input',
    confidence: Number(confidence.toFixed(2)),
    source: 'heuristic',
    matched_keywords: [],
    reasons,
    resolution: {
      shape: 'task_session',
      task_kind: 'service_operation',
      result_shape: 'summary',
    },
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

function inferMessagingBridgePlatformId(utterance: string): string | undefined {
  const normalized = normalizeForTriggerMatch(utterance);
  if (!normalized) return undefined;

  if (normalized.includes('slack') || normalized.includes('すらっく')) return 'slack';
  if (normalized.includes('imessage') || normalized.includes('i message') || normalized.includes('あいめっせーじ')) return 'imessage';
  if (normalized.includes('telegram') || normalized.includes('てれぐらむ')) return 'telegram';
  if (normalized.includes('line') || normalized.includes('らいん')) return 'line';
  if (normalized.includes('discord') || normalized.includes('でぃすこーど')) return 'discord';
  if (normalized.includes('teams') || normalized.includes('てぃーむす')) return 'teams';

  return undefined;
}

function inferSelectedParameters(
  intentId: string | undefined,
  utterance: string
): IntentResolutionSelectedParameters | undefined {
  if (intentId !== 'setup-messaging-bridge') return undefined;
  const platformId = inferMessagingBridgePlatformId(utterance);
  if (!platformId) return undefined;
  return {
    platform_id: platformId,
    target_platform: platformId,
  };
}

export function resolveIntentResolutionPacket(utterance: string): IntentResolutionPacket {
  const trimmed = utterance.trim();
  const scoringPolicy = loadIntentResolutionPolicy().catalog_scoring;
  const ontology = loadIntentDomainOntology();
  const surfaceIntents = loadStandardIntentCatalog().filter((intent) => {
    if (!intent.id) return false;
    const ontologyEntry = ontology.get(intent.id);
    if (ontologyEntry) return ontologyEntry.exposed_to_surface !== false;
    if (typeof intent.exposed_to_surface === 'boolean') return intent.exposed_to_surface;
    return intent.category === scoringPolicy.catalog_intent_category;
  });
  const candidates = [
    ...surfaceIntents
      .map((intent) => scoreCatalogIntent(trimmed, intent))
      .filter((candidate): candidate is IntentResolutionCandidate => Boolean(candidate)),
    ...[scoreScheduleCoordinationIntent(trimmed)].filter(
      (candidate): candidate is IntentResolutionCandidate => Boolean(candidate)
    ),
    ...[scoreApprovalWorkflowIntent(trimmed)].filter(
      (candidate): candidate is IntentResolutionCandidate => Boolean(candidate)
    ),
    ...[scoreVoiceInputIntent(trimmed)].filter(
      (candidate): candidate is IntentResolutionCandidate => Boolean(candidate)
    ),
    ...[scoreScheduleReadAgendaIntent(trimmed)].filter(
      (candidate): candidate is IntentResolutionCandidate => Boolean(candidate)
    ),
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
  const selectedParameters = inferSelectedParameters(selected?.intent_id, trimmed);
  const bundleById = new Map<string, IntentResolutionBundleCandidate>();
  for (const candidate of sorted) {
    const bundle = resolveCapabilityBundleForIntent(candidate.intent_id);
    if (!bundle) continue;
    bundleById.set(bundle.bundle_id, {
      bundle_id: bundle.bundle_id,
      status: bundle.status,
      kind: bundle.kind,
      summary: bundle.summary,
      required_actuators: bundle.required_actuators || [],
      intents: bundle.intents || [],
      references: bundle.references || [],
    });
  }

  for (const bundle of resolveCapabilityBundlesForUtterance(trimmed)) {
    if (bundleById.has(bundle.bundle_id)) continue;
    bundleById.set(bundle.bundle_id, {
      bundle_id: bundle.bundle_id,
      status: bundle.status,
      kind: bundle.kind,
      summary: bundle.summary,
      required_actuators: bundle.required_actuators || [],
      intents: bundle.intents || [],
      references: bundle.references || [],
    });
  }

  return {
    kind: 'intent_resolution_packet',
    utterance: trimmed,
    selected_intent_id: selected?.intent_id,
    selected_confidence: selected?.confidence,
    selected_resolution: selected?.resolution,
    selected_parameters: selectedParameters,
    candidates: sorted,
    bundle_candidates: [...bundleById.values()],
  };
}
