import { pathResolver } from '../path-resolver.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { defineCatalog, type GovernedCatalog } from '../foundation/governed-catalog.js';
import { clamp } from '../foundation/text.js';
import { assertSafeRepositoryPath, safeExistsSync } from '../secure-io.js';
import { matchesAnyTextRule, type TextMatchRule } from '../text-rule-matcher.js';
import {
  resolveCapabilityBundleForIntent,
  resolveCapabilityBundlesForUtterance,
} from '../capability-bundle-registry.js';
import {
  buildContextualIntentFrame,
  type ContextualIntentFrame,
} from '../contextual-intent-frame.js';
import { sanitizeIntentPathSegment } from './intent-path-utils.js';
import {
  intentPhraseFlags,
  intentPhraseSource,
  matchesIntentPhrase,
} from './intent-phrase-lexicon.js';
import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '../seam.js';

const STANDARD_INTENTS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/standard-intents.schema.json'
);
const INTENT_RESOLUTION_POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/intent-resolution-policy.schema.json'
);
const PERSONAL_INTENT_OVERLAY_PATH = pathResolver.knowledge(
  'personal/orchestration/intent-catalog.json'
);
const CONFIDENTIAL_INTENT_OVERLAY_DIR = 'confidential';

import type { StandardIntentDefinition } from './standard-intents.generated.js';
export type {
  StandardIntentDefinition,
  StandardIntentCategory,
  StandardIntentTarget,
  StandardIntentAction,
  StandardIntentExecutionShape,
  StandardIntentMissionClass,
  StandardIntentRiskProfile,
  StandardIntentResolution,
  StandardIntentPipelineStep,
} from './standard-intents.generated.js';

export type IntentDomainOntologyEntry = {
  intent_id: string;
  category?: string;
  legacy_category?: string;
  target?: string;
  action?: string;
  object?: string;
  exposed_to_surface?: boolean;
  execution_shape?: string;
  mission_class?: string;
  workflow_template?: string;
  team_template?: string;
  risk_profile?: string;
  execution_profile_id?: string;
  outcome_ids?: string[];
  intake_requirements?: string[];
  actuator_requirements?: string[];
  readiness_required?: string[];
  evidence_required?: string[];
  reasoning_requirements?: Record<string, unknown>;
};

type StandardIntentCatalogFile = {
  intents?: StandardIntentDefinition[];
};

export type IntentDomainOntologyFile = {
  intents?: IntentDomainOntologyEntry[];
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
  service_name?: string;
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
  contextual_frame?: ContextualIntentFrame;
  candidates: IntentResolutionCandidate[];
  bundle_candidates?: IntentResolutionBundleCandidate[];
}

export type IntentResolutionTier = 'personal' | 'confidential' | 'public';

export interface IntentResolutionOptions {
  tier?: IntentResolutionTier;
  tenantId?: string;
  overlayPaths?: string[];
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
let intentResolutionPolicyCache: IntentResolutionPolicyFile | null = null;
const resolvedIntentCatalogCache = new Map<string, StandardIntentDefinition[]>();

const standardIntentCatalog = defineCatalog<StandardIntentCatalogFile>({
  id: 'standard-intents',
  path: () => pathResolver.knowledge('product/governance/standard-intents.json'),
  schema: STANDARD_INTENTS_SCHEMA_PATH,
});

const intentResolutionPolicyCatalog = defineCatalog<IntentResolutionPolicyFile>({
  id: 'intent-resolution-policy',
  path: () => pathResolver.knowledge('product/governance/intent-resolution-policy.json'),
  schema: INTENT_RESOLUTION_POLICY_SCHEMA_PATH,
});

const intentDomainOntologyCatalog = defineCatalog<IntentDomainOntologyFile>({
  id: 'intent-domain-ontology',
  path: () => pathResolver.knowledge('product/governance/intent-domain-ontology.json'),
  schema: pathResolver.knowledge('product/schemas/intent-domain-ontology.schema.json'),
});

const intentCatalogOverlayCache = new Map<string, GovernedCatalog<StandardIntentCatalogFile>>();

function getIntentCatalogOverlay(filePath: string): GovernedCatalog<StandardIntentCatalogFile> {
  const safeFilePath = assertSafeRepositoryPath(filePath);
  const cached = intentCatalogOverlayCache.get(safeFilePath);
  if (cached) return cached;
  const catalog = defineCatalog<StandardIntentCatalogFile>({
    id: 'intent-catalog-overlay',
    path: safeFilePath,
    schema: STANDARD_INTENTS_SCHEMA_PATH,
  });
  intentCatalogOverlayCache.set(safeFilePath, catalog);
  return catalog;
}

export function loadStandardIntentCatalog(): StandardIntentDefinition[] {
  if (standardIntentCache) return standardIntentCache;
  const parsed = standardIntentCatalog.load();
  standardIntentCache = Array.isArray(parsed.intents) ? parsed.intents : [];
  return standardIntentCache;
}

function loadIntentCatalogFromPath(filePath: string): StandardIntentDefinition[] {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeFilePath)) return [];
  const parsed = getIntentCatalogOverlay(safeFilePath).load();
  return Array.isArray(parsed.intents) ? parsed.intents : [];
}

function defaultTenantId(): string | undefined {
  const tenant =
    getRegisteredEnvText('KYBERION_TENANT')?.trim() ||
    getRegisteredEnvText('KYBERION_CUSTOMER')?.trim() ||
    '';
  return tenant || undefined;
}

function buildIntentOverlayPaths(options: IntentResolutionOptions): string[] {
  const paths: string[] = [];
  if (options.tier === 'personal') {
    paths.push(PERSONAL_INTENT_OVERLAY_PATH);
  } else if (options.tier === 'confidential') {
    paths.push(PERSONAL_INTENT_OVERLAY_PATH);
    const tenantId = sanitizeIntentPathSegment(options.tenantId || defaultTenantId() || '');
    if (tenantId) {
      paths.push(
        pathResolver.knowledge(
          `${CONFIDENTIAL_INTENT_OVERLAY_DIR}/${tenantId}/orchestration/intent-catalog.json`
        )
      );
    }
  }

  for (const candidate of options.overlayPaths || []) {
    const normalized = candidate.trim();
    if (normalized && !paths.includes(normalized)) paths.push(normalized);
  }
  return paths;
}

function mergeIntentDefinition(
  base: StandardIntentDefinition,
  overlay: StandardIntentDefinition
): StandardIntentDefinition {
  const merged: StandardIntentDefinition = { ...base, ...overlay };
  if (base.surface_examples || overlay.surface_examples) {
    merged.surface_examples = Array.from(
      new Set([...(base.surface_examples || []), ...(overlay.surface_examples || [])])
    );
  }
  if (base.trigger_keywords || overlay.trigger_keywords) {
    merged.trigger_keywords = Array.from(
      new Set([...(base.trigger_keywords || []), ...(overlay.trigger_keywords || [])])
    );
  }
  if (base.outcome_ids || overlay.outcome_ids) {
    merged.outcome_ids = Array.from(
      new Set([...(base.outcome_ids || []), ...(overlay.outcome_ids || [])])
    );
  }
  if (base.plan_outline || overlay.plan_outline) {
    merged.plan_outline = Array.from(
      new Set([...(base.plan_outline || []), ...(overlay.plan_outline || [])])
    );
  }
  if (base.intake_requirements || overlay.intake_requirements) {
    merged.intake_requirements = Array.from(
      new Set([...(base.intake_requirements || []), ...(overlay.intake_requirements || [])])
    );
  }
  if (base.pipeline || overlay.pipeline) {
    merged.pipeline = [...(base.pipeline || []), ...(overlay.pipeline || [])];
  }
  if (base.resolution || overlay.resolution) {
    merged.resolution = { ...(base.resolution || {}), ...(overlay.resolution || {}) };
  }
  return merged;
}

function resolvedCatalogCacheKey(options: IntentResolutionOptions): string {
  return JSON.stringify({
    tier: options.tier || 'public',
    tenantId: sanitizeIntentPathSegment(options.tenantId || defaultTenantId() || ''),
    overlayPaths: [...new Set(options.overlayPaths || [])].sort(),
  });
}

export function loadResolvedStandardIntentCatalog(
  options: IntentResolutionOptions = {}
): StandardIntentDefinition[] {
  const cacheKey = resolvedCatalogCacheKey(options);
  const cached = resolvedIntentCatalogCache.get(cacheKey);
  if (cached) return cached;

  const baseCatalog = loadStandardIntentCatalog();
  const overlayPaths = buildIntentOverlayPaths(options);
  if (overlayPaths.length === 0) {
    resolvedIntentCatalogCache.set(cacheKey, baseCatalog);
    return baseCatalog;
  }

  const mergedById = new Map<string, StandardIntentDefinition>();
  for (const intent of baseCatalog) {
    if (intent.id) mergedById.set(intent.id, intent);
  }
  for (const overlayPath of overlayPaths) {
    for (const overlayIntent of loadIntentCatalogFromPath(overlayPath)) {
      const overlayId = overlayIntent.id?.trim();
      if (!overlayId) continue;
      const existing = mergedById.get(overlayId);
      if (!existing) continue;
      mergedById.set(overlayId, mergeIntentDefinition(existing, overlayIntent));
    }
  }

  const resolved = baseCatalog.map((intent) => {
    if (!intent.id) return intent;
    return mergedById.get(intent.id) || intent;
  });
  resolvedIntentCatalogCache.set(cacheKey, resolved);
  return resolved;
}

function loadIntentResolutionPolicy(): IntentResolutionPolicyFile {
  if (intentResolutionPolicyCache) return intentResolutionPolicyCache;
  intentResolutionPolicyCache = intentResolutionPolicyCatalog.load();
  return intentResolutionPolicyCache;
}

export function loadIntentDomainOntologyCatalog(): IntentDomainOntologyFile {
  return intentDomainOntologyCatalog.load();
}

function loadIntentDomainOntology(): Map<string, IntentDomainOntologyEntry> {
  if (intentDomainOntologyCache) return intentDomainOntologyCache;
  const parsed = loadIntentDomainOntologyCatalog();
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
  return text.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

// Converts katakana to hiragana so "\u30b9\u30e9\u30c3\u30af" and "\u3059\u3089\u3063\u304f" both match "slack".
function normalizeKatakanaToHiragana(text: string): string {
  return text.replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));
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

function scoreCatalogIntent(
  utterance: string,
  intent: StandardIntentDefinition
): IntentResolutionCandidate | null {
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
    score = Math.max(
      score,
      Math.min(
        policy.keyword_base_confidence + matchedKeywords.length * policy.keyword_increment,
        policy.keyword_max_confidence
      )
    );
    reasons.push(`matched keywords: ${matchedKeywords.join(', ')}`);
  }

  const utteranceTokens = tokenize(utterance);
  const exactExample = (intent.surface_examples || []).find(
    (example) => normalizeFreeText(example) === normalized
  );
  if (exactExample) {
    score = Math.max(score, policy.exact_surface_example_confidence);
    reasons.push(`exact surface example match: ${exactExample}`);
  }

  const containingExample = (intent.surface_examples || []).find((example) => {
    const normalizedExample = normalizeFreeText(example);
    return (
      normalizedExample.length >= 4 &&
      (normalized.includes(normalizedExample) || normalizedExample.includes(normalized))
    );
  });
  if (containingExample) {
    score = Math.max(score, policy.surface_containment_confidence);
    reasons.push(`surface example containment: ${containingExample}`);
  }

  const exampleTokens = (intent.surface_examples || []).flatMap((example) => tokenize(example));
  const overlap = utteranceTokens.filter((token) => exampleTokens.includes(token));
  if (overlap.length > 0) {
    score = Math.max(
      score,
      Math.min(
        score + overlap.length * policy.surface_overlap_increment,
        policy.surface_overlap_max_confidence
      )
    );
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

function scoreScheduleReadAgendaIntent(
  utterance: string,
  frame: ContextualIntentFrame = buildContextualIntentFrame(utterance)
): IntentResolutionCandidate | null {
  const normalized = normalizeFreeText(utterance);
  // A meeting named only as a time anchor ("before the meeting") is not a calendar request.
  const anchorPattern = new RegExp(
    intentPhraseSource('schedule.agenda_temporal_anchor'),
    `${intentPhraseFlags('schedule.agenda_temporal_anchor').replace('g', '')}g`
  );
  const calendarHint = matchesIntentPhrase(
    normalized.replace(anchorPattern, ' '),
    'schedule.agenda_topic'
  );
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
  if (matchesIntentPhrase(normalized, 'intent_resolution.agenda_read_verb')) {
    confidence += 0.04;
    reasons.push('read verb matched');
  }
  confidence = clamp(confidence, 0, 0.97);

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

function scoreScheduleCoordinationIntent(
  utterance: string,
  frame: ContextualIntentFrame = buildContextualIntentFrame(utterance)
): IntentResolutionCandidate | null {
  const normalized = normalizeFreeText(utterance);
  const scheduleHint = matchesIntentPhrase(
    normalized,
    'intent_resolution.schedule_coordination_topic'
  );
  const changeHint = frame.action === 'change';
  const meetingProxyHint = matchesIntentPhrase(normalized, 'intent_resolution.meeting_proxy_cue');
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
  confidence = clamp(confidence, 0, 0.97);

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
  const approvalHint = matchesIntentPhrase(normalized, 'approval.vocabulary');
  if (!approvalHint) return null;

  const requestHint = matchesIntentPhrase(normalized, 'approval.request_verb');
  const resolveHint = matchesIntentPhrase(normalized, 'approval.resolve_verb');

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
  if (matchesIntentPhrase(normalized, 'approval.ringi_vocabulary')) {
    confidence += 0.08;
    reasons.push('ringi vocabulary matched');
  }
  if (matchesIntentPhrase(normalized, 'approval.workflow_system_context')) {
    confidence += 0.04;
    reasons.push('workflow/system context matched');
  }

  return {
    intent_id: intentId,
    confidence: Number(clamp(confidence, 0, 0.97).toFixed(2)),
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
  const voiceInputHint = matchesIntentPhrase(normalized, 'voice_input.request');
  if (!voiceInputHint) return null;

  let confidence = 0.84;
  const reasons: string[] = ['voice input toggle request'];
  if (matchesIntentPhrase(normalized, 'voice_input.core_vocabulary')) {
    confidence += 0.08;
    reasons.push('voice input vocabulary matched');
  }
  if (matchesIntentPhrase(normalized, 'voice_input.enable_cue')) {
    confidence += 0.03;
    reasons.push('enable phrasing matched');
  }
  confidence = clamp(confidence, 0, 0.97);

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

function scoreBrowserFillIntent(utterance: string): IntentResolutionCandidate | null {
  const normalized = normalizeForTriggerMatch(utterance);
  const fillVerb = matchesIntentPhrase(normalized, 'intent_resolution.browser_fill_verb');
  const fieldHint = matchesIntentPhrase(normalized, 'intent_resolution.browser_field_hint');
  if (!fillVerb || !fieldHint) return null;

  return {
    intent_id: 'browser-step',
    confidence: 0.96,
    source: 'heuristic',
    matched_keywords: [],
    reasons: ['browser field-fill request matched'],
    resolution: {
      shape: 'browser_session',
      result_shape: 'browser_step',
    },
  };
}

function buildLegacyCandidates(utterance: string): IntentResolutionCandidate[] {
  return loadIntentResolutionPolicy()
    .legacy_candidates.filter((candidate) => matchesAnyTextRule(utterance, candidate.patterns))
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

  // i18n-exempt: JA input keyword matcher
  if (normalized.includes('slack') || normalized.includes('すらっく')) return 'slack';
  if (
    normalized.includes('imessage') ||
    normalized.includes('i message') ||
    // i18n-exempt: JA input keyword matcher
    normalized.includes('あいめっせーじ')
  )
    return 'imessage';
  // i18n-exempt: JA input keyword matcher
  if (normalized.includes('telegram') || normalized.includes('てれぐらむ')) return 'telegram';
  // i18n-exempt: JA input keyword matcher
  if (normalized.includes('line') || normalized.includes('らいん')) return 'line';
  // i18n-exempt: JA input keyword matcher
  if (normalized.includes('discord') || normalized.includes('でぃすこーど')) return 'discord';
  // i18n-exempt: JA input keyword matcher
  if (normalized.includes('teams') || normalized.includes('てぃーむす')) return 'teams';

  return undefined;
}

export type IntentParamExtractor = (
  utterance: string
) => IntentResolutionSelectedParameters | undefined;

const intentParamExtractorSeam = createSeam<IntentParamExtractor>({
  key: 'intent:param-extract',
  multiplicity: 'named',
  catalog: coreSeamCatalog,
});

export function registerIntentParamExtractor(
  intentId: string,
  extractor: IntentParamExtractor,
  metadata: SeamProviderMetadata = {
    provenance: 'builtin',
    source: 'libs/core/intent/intent-resolution.ts',
  }
): () => void {
  return intentParamExtractorSeam.register(intentId, extractor, metadata);
}

export function getIntentParamExtractor(
  intentId: string | undefined
): IntentParamExtractor | undefined {
  if (!intentId) return undefined;
  return intentParamExtractorSeam.getOptional(intentId);
}

function extractMessagingBridgeParameters(
  utterance: string
): IntentResolutionSelectedParameters | undefined {
  const platformId = inferMessagingBridgePlatformId(utterance);
  if (!platformId) return undefined;
  return { platform_id: platformId, target_platform: platformId };
}

function extractServiceNameParameters(
  utterance: string
): IntentResolutionSelectedParameters | undefined {
  const serviceMatch =
    utterance.match(
      /([A-Za-z0-9._-]+)\s*(?:の|を)?\s*(?:再起動|restart|起動|停止|stop|status|状態|ログ)/i
    ) || utterance.match(/service\s+([A-Za-z0-9._-]+)/i);
  if (!serviceMatch?.[1]) return undefined;
  return { service_name: serviceMatch[1] };
}

registerIntentParamExtractor('setup-messaging-bridge', extractMessagingBridgeParameters);
for (const serviceIntentId of [
  'inspect-service',
  'start-service',
  'stop-service',
  'restart-service',
]) {
  registerIntentParamExtractor(serviceIntentId, extractServiceNameParameters);
}

function inferSelectedParameters(
  intentId: string | undefined,
  utterance: string
): IntentResolutionSelectedParameters | undefined {
  const extractor = getIntentParamExtractor(intentId);
  const parameters = extractor?.(utterance) || {};

  return Object.keys(parameters).length > 0 ? parameters : undefined;
}

export function resolveIntentResolutionPacket(
  utterance: string,
  options: IntentResolutionOptions = {}
): IntentResolutionPacket {
  const trimmed = utterance.trim();
  const contextualFrame = buildContextualIntentFrame(trimmed);
  const scoringPolicy = loadIntentResolutionPolicy().catalog_scoring;
  const ontology = loadIntentDomainOntology();
  const surfaceIntents = loadResolvedStandardIntentCatalog(options).filter((intent) => {
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
    ...[scoreScheduleCoordinationIntent(trimmed, contextualFrame)].filter(
      (candidate): candidate is IntentResolutionCandidate => Boolean(candidate)
    ),
    ...[scoreApprovalWorkflowIntent(trimmed)].filter(
      (candidate): candidate is IntentResolutionCandidate => Boolean(candidate)
    ),
    ...[scoreVoiceInputIntent(trimmed)].filter(
      (candidate): candidate is IntentResolutionCandidate => Boolean(candidate)
    ),
    ...[scoreBrowserFillIntent(trimmed)].filter(
      (candidate): candidate is IntentResolutionCandidate => Boolean(candidate)
    ),
    ...[scoreScheduleReadAgendaIntent(trimmed, contextualFrame)].filter(
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
  // A greeting can occur inside a substantive request (for example,
  // `「こんにちは」を英語に翻訳して`).  The generic conversation intent
  // intentionally has a strong greeting score, so prefer a near-tied,
  // concrete task-session candidate in that case.
  const topCandidate = sorted[0];
  const concreteTaskCandidate = sorted.find(
    (candidate) => candidate.resolution?.shape === 'task_session'
  );
  const selectedCandidate =
    topCandidate?.intent_id === 'continue-conversation' &&
    concreteTaskCandidate &&
    concreteTaskCandidate.confidence >= topCandidate.confidence - 0.05
      ? concreteTaskCandidate
      : topCandidate;
  const selected =
    selectedCandidate && selectedCandidate.confidence >= scoringPolicy.selected_confidence_threshold
      ? selectedCandidate
      : undefined;
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
    contextual_frame: contextualFrame,
    candidates: sorted,
    bundle_candidates: [...bundleById.values()],
  };
}

/**
 * Resolver convergence (GAP1): choose the intent to drive execution.
 *
 * `resolveIntentResolutionPacket` is the canonical Stage-1 resolver. When it
 * produced a confident selection (`selected_intent_id` is only set when the top
 * candidate clears `selected_confidence_threshold`), execution should run off
 * THAT decision — passing the intent_id makes `compileIntent` hit its exact-ID
 * match (confidence 1.0) instead of independently re-resolving the raw utterance
 * (which previously let the two resolvers disagree). Falls back to the raw
 * utterance when there is no confident selection, preserving prior behavior.
 */
export function chooseExecutionIntent(
  packet: Pick<IntentResolutionPacket, 'selected_intent_id'>,
  rawIntent: string
): string {
  return packet.selected_intent_id || rawIntent;
}

/**
 * Improvement-loop (④→①) closure: pull accumulated lessons — feedback-loop trace
 * hints (ingested into the knowledge index by `knowledge-index._scanProductTier`)
 * and promoted memory — relevant to an intent, so the next execution is biased by
 * what past runs learned. This is the *consumption* side of the learning loop:
 * capture (runFeedbackLoop → hints → knowledge-index) was already wired; this makes
 * the captured knowledge actually reach the next execution instead of only being
 * searchable on demand via the MCP tool.
 *
 * Best-effort and non-blocking: any failure in the knowledge subsystem yields `[]`
 * so intent execution is never blocked by a hint lookup. Uses a dynamic import to
 * avoid a load-time dependency cycle with the knowledge index.
 */
export async function gatherImprovementHints(
  intent: string,
  options: { maxResults?: number } = {}
): Promise<Array<{ topic: string; hint: string; confidence: number }>> {
  const topic = (intent ?? '').trim();
  if (!topic) return [];
  try {
    const mod = await import('../knowledge/knowledge-index.js');
    const index = await mod.buildKnowledgeIndex();
    const hints = await mod.queryKnowledgeHybrid(index, topic, {
      maxResults: options.maxResults ?? 5,
    });
    return hints.map((h) => ({ topic: h.topic, hint: h.hint, confidence: h.confidence }));
  } catch {
    return [];
  }
}
