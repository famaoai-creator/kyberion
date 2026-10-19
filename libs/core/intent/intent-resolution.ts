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
import { segmentWords } from '../locale-normalize.js';
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

const wholeWordPatterns = new Map<string, RegExp>();

function wholeWordPattern(keyword: string): RegExp {
  let pattern = wholeWordPatterns.get(keyword);
  if (!pattern) {
    pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(keyword)}(?:e?s)?($|[^a-z0-9])`);
    wholeWordPatterns.set(keyword, pattern);
  }
  return pattern;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

// Maps half-width katakana (\uff76-\uff9f) to full-width via per-run NFKC,
// which also composes voicing marks (\uff76\uff9e -> \u30ac), so the
// katakana->hiragana pass below unifies it too. Voice input and legacy
// systems emit half-width kana.
function normalizeHalfWidthKatakana(text: string): string {
  return text.replace(/[\uff61-\uff9f]+/g, (run) => run.normalize('NFKC'));
}

// Word-final prolonged marks are dropped (\u30b5\u30fc\u30d0\u30fc ==
// \u30b5\u30fc\u30d0), the dominant loanword spelling variant; internal
// ones stay so \u30ab\u30fc\u30c9 and \u304b\u3060 still differ.
// Implemented as a plain scan — a /\u30fc+(?=\s|$)/-style pattern
// backtracks polynomially on attacker-controlled runs of \u30fc (CodeQL).
function normalizeJaTrailingProlonged(text: string): string {
  const parts = text.split(/(\s+)/u);
  for (let i = 0; i < parts.length; i += 1) {
    if (i % 2 === 1) continue; // whitespace runs sit at odd indices
    const word = parts[i]!;
    let end = word.length;
    while (end > 0 && word.charCodeAt(end - 1) === 0x30fc) end -= 1;
    if (end !== word.length) parts[i] = word.slice(0, end);
  }
  return parts.join('');
}

// Honorific prefixes are dropped only before a 2+ kanji stem (\u3054\u78ba\u8a8d ->
// \u78ba\u8a8d, \u3054\u5229\u7528 -> \u5229\u7528). Lexicalized
// \u304a/\u3054 words — \u304a\u91d1, \u3054\u98ef, \u304a\u9858\u3044, \u304a\u77e5\u3089\u305b — keep the
// prefix, because the single-kanji remnant is either dropped downstream or
// becomes an over-broad keyword (\u304a\u91d1 -> \u91d1 would hit \u91d1\u66dc\u65e5/\u6599\u91d1/\u73fe\u91d1).
function stripJaHonorificPrefixes(text: string): string {
  return text.replace(/(^|\s)[\u304a\u3054](?=[\u3400-\u9fff][\u3400-\u9fff])/g, '$1');
}

// Trailing request / politeness markers collapse onto the stem, so a request
// ending in "してください"/"します" hits the same triggers as the bare noun.
// Two ending classes behave differently:
//   - chain (te-form / request): may peel repeatedly ("確認してください" ->
//     "確認して" -> "確認");
//   - terminal (copula / masu): strip once and stop — "クリスマスです" must
//     keep "クリスマス", not cascade through "ます" into "クリスマ".
// Masu-family endings additionally require a hiragana/kanji char before them,
// so loanword tails ("クリスマス", "コスモス") never look like verb stems.
// Deliberately conservative overall: bare \u305f\u3044 / \u3057\u305f\u3044 stay
// excluded because real words end that way (\u671f\u5f85, \u72b6\u614b), and
// single-kana tails are never stripped. Longest-first so layered endings peel
// correctly.
const JA_CHAIN_ENDINGS =
  // i18n-exempt: Japanese request-ending rule data for trigger matching, not user-facing copy
  'ていただけないでしょうか ていただけますか ていただきたい ていただけます していただければ してもらえませんか してもらえますか してもらいたい てもらえますか てもらいたい してください くださいませんか くださいませ ください 下さい ておいてください ておいて ておきました ておきます てみました てみます ていました ています てくれますか てきました ていた てある てみて してほしい てほしい てくれ してね して ちょうだい おねがいします おねがい お願いします お願い ねがいします'
    .split(' ')
    .sort((a, b) => b.length - a.length);

const JA_TERMINAL_COPULA_ENDINGS =
  // i18n-exempt: Japanese copula endings for trigger matching, not user-facing copy
  'でしょうか でしょう でした ですか です'.split(' ').sort((a, b) => b.length - a.length);

const JA_TERMINAL_MASU_ENDINGS =
  // i18n-exempt: Japanese masu-form endings for trigger matching, not user-facing copy
  'ませんでした ませんか いません いました ました ません ましょうか ましょう ますか います ます'
    .split(' ')
    .sort((a, b) => b.length - a.length);

// Hiragana or kanji — a masu stem never ends in katakana (or ascii/digits),
// which is what keeps "クリスマスです" from peeling "ます" off "クリスマス".
const JA_STEM_CHAR = /[\u3040-\u309f\u3400-\u9fff]/;

function stripJaRequestEndings(text: string): string {
  let out = text;
  for (let pass = 0; pass < 4; pass += 1) {
    const candidates: Array<{ ending: string; terminal: boolean }> = [];
    const chain = JA_CHAIN_ENDINGS.find(
      (entry) => out.endsWith(entry) && out.length > entry.length
    );
    if (chain) candidates.push({ ending: chain, terminal: false });
    for (const entry of JA_TERMINAL_COPULA_ENDINGS) {
      if (out.endsWith(entry) && out.length > entry.length) {
        candidates.push({ ending: entry, terminal: true });
        break;
      }
    }
    for (const entry of JA_TERMINAL_MASU_ENDINGS) {
      if (
        out.endsWith(entry) &&
        out.length > entry.length &&
        JA_STEM_CHAR.test(out[out.length - entry.length - 1] ?? '')
      ) {
        candidates.push({ ending: entry, terminal: true });
        break;
      }
    }
    candidates.sort((a, b) => b.ending.length - a.ending.length);
    const pick = candidates[0];
    if (!pick) break;
    out = out.slice(0, -pick.ending.length).trimEnd();
    if (pick.terminal) break;
  }
  return out;
}

/**
 * Script-preserving normalization — everything except katakana\u2192hiragana.
 * Full-width\u2192half-width, half-width katakana NFKC, standard text
 * normalization, then word-final \u30fc, honorific \u304a/\u3054, and trailing
 * request endings. Katakana survives on purpose: the ending stripper needs it
 * to tell loanword tails (\u30af\u30ea\u30b9\u30de\u30b9) from verb stems, and
 * word segmentation needs it because ICU groups katakana runs as words while
 * an unknown hiragana run splits per character.
 */
function normalizePreSegment(utterance: string): string {
  const prepped = normalizeFreeText(
    normalizeHalfWidthKatakana(normalizeFullWidthToHalfWidth(utterance))
  );
  return stripJaRequestEndings(stripJaHonorificPrefixes(normalizeJaTrailingProlonged(prepped)));
}

/**
 * Locale-aware normalization for trigger matching. Japanese utterances match
 * ASCII trigger keywords and vice versa.
 */
export function normalizeForTriggerMatch(utterance: string): string {
  return normalizeKatakanaToHiragana(normalizePreSegment(utterance));
}

const preSegmentMemo = new Map<string, string>();
const tokenizeMemo = new Map<string, string[]>();

// Memoized so the per-intent scoring loop does not re-run the pipeline for the
// same utterance/keyword strings; bounded so a long session cannot grow it.
function normalizePreSegmentCached(utterance: string): string {
  const cached = preSegmentMemo.get(utterance);
  if (cached !== undefined) return cached;
  const out = normalizePreSegment(utterance);
  if (preSegmentMemo.size > 256) preSegmentMemo.clear();
  preSegmentMemo.set(utterance, out);
  return out;
}

function normalizeForTriggerMatchCached(utterance: string): string {
  return normalizeKatakanaToHiragana(normalizePreSegmentCached(utterance));
}

// Word-final prolonged marks and honorific prefixes applied per token: in
// spaceless text "サーバーの費用" has no \s boundary, so the string-level pass
// only fires at the very end — the token-level pass makes \u30fc-stripping and
// \u304a/\u3054-stripping fire mid-sentence too.
const JA_TOKEN_HONORIFIC_PREFIX = /^[\u304a\u3054](?=[\u3400-\u9fff][\u3400-\u9fff])/;

// Linear scan rather than /\u30fc+$/ — a quantifier over attacker-controlled
// input can still backtrack polynomially per start position (CodeQL).
function stripTokenProlongedTail(token: string): string {
  let end = token.length;
  while (end > 0 && token.charCodeAt(end - 1) === 0x30fc) end -= 1;
  return token.slice(0, end);
}

// Post-normalization auxiliary/particle fragments that ICU emits as tokens.
// They recur across unrelated utterances, so they must not count as evidence
// for surface-example overlap.
const JA_TOKEN_STOPWORDS = new Set(
  // i18n-exempt: Japanese auxiliary/particle rule data for overlap scoring, not user-facing copy
  'して くだ さい おい ます あり おり いる いた こと ため など から まで より ので のに でも けど これ それ あれ この その あの よう'.split(
    ' '
  )
);

// Single kanji are content words (駅, 雨, 猫) — only single kana/latin
// fragments get dropped by the length floor.
const JA_SINGLE_KANJI = /[\u3400-\u9fff]/u;

function tokenize(value: string): string[] {
  // Word segmentation (not delimiter splitting): spaceless scripts like
  // Japanese would otherwise arrive as a single token and the surface-example
  // overlap score below could never fire on them.
  const cached = tokenizeMemo.get(value);
  if (cached) return cached;
  // Segment on the script-preserving text — ICU keeps katakana runs together
  // but splits unknown hiragana per character — then unify per token, and
  // split identifiers (foo_bar, file.txt) that ICU keeps joined.
  const tokens = segmentWords(normalizePreSegmentCached(value))
    .map((token) =>
      stripTokenProlongedTail(normalizeKatakanaToHiragana(token))
        .replace(JA_TOKEN_HONORIFIC_PREFIX, '')
        .trim()
    )
    .flatMap((token) => token.split(/[^\p{L}\p{N}]+/u))
    .filter(
      (token) =>
        !JA_TOKEN_STOPWORDS.has(token) && (token.length >= 2 || JA_SINGLE_KANJI.test(token))
    );
  // Frozen because the memo hands out the same array to every caller.
  Object.freeze(tokens);
  if (tokenizeMemo.size > 256) tokenizeMemo.clear();
  tokenizeMemo.set(value, tokens);
  return tokens;
}

/**
 * Tie-break weight for candidates with equal confidence: matched keywords that
 * few intents declare ("天気") outweigh ones many intents share ("教えて").
 * Kept off the packet so the resolution contract does not change.
 */
const candidateSpecificity = new WeakMap<IntentResolutionCandidate, number>();

/** Number of intents whose keywords or examples mention `keyword` — memoised per catalog. */
function keywordDocumentFrequency(
  intents: StandardIntentDefinition[]
): (keyword: string) => number {
  const texts = intents.map((intent) =>
    [...(intent.trigger_keywords || []), ...(intent.surface_examples || [])]
      .map((value) => String(value).toLowerCase())
      .join('\n')
  );
  const memo = new Map<string, number>();
  return (keyword) => {
    const key = keyword.toLowerCase();
    let count = memo.get(key);
    if (count === undefined) {
      count = texts.filter((text) => text.includes(key)).length;
      memo.set(key, count);
    }
    return count;
  };
}

const keywordFrequencyByCatalog = new WeakMap<
  StandardIntentDefinition[],
  (keyword: string) => number
>();

function cachedKeywordDocumentFrequency(
  catalog: StandardIntentDefinition[],
  surfaceIntents: StandardIntentDefinition[]
): (keyword: string) => number {
  let frequency = keywordFrequencyByCatalog.get(catalog);
  if (!frequency) {
    frequency = keywordDocumentFrequency(surfaceIntents);
    keywordFrequencyByCatalog.set(catalog, frequency);
  }
  return frequency;
}

/** A requested document project outranks incidental meeting/review topic words. */
export function isDocumentProjectRequest(utterance: string): boolean {
  return (
    matchesIntentPhrase(utterance, 'project.explicit_new_project') &&
    matchesIntentPhrase(utterance, 'project.document_creation_request') &&
    !matchesIntentPhrase(utterance, 'project.creation_negated') &&
    !matchesIntentPhrase(utterance, 'approval.resolve_verb') &&
    !matchesIntentPhrase(utterance, 'approval.request_creation')
  );
}

function scoreCatalogIntent(
  utterance: string,
  intent: StandardIntentDefinition,
  keywordFrequency?: (keyword: string) => number
): IntentResolutionCandidate | null {
  const policy = loadIntentResolutionPolicy().catalog_scoring;
  const normalized = normalizeFreeText(utterance);
  const localizedNormalized = normalizeForTriggerMatchCached(utterance);
  const utteranceTokens = tokenize(utterance);
  const matchedKeywords = (intent.trigger_keywords || []).filter((keyword) => {
    const kw = String(keyword).toLowerCase();
    // Empty/whitespace keywords must not become a universal includes() match.
    if (!kw.trim()) return false;
    // ASCII keywords match whole words only ("search" must not fire inside "research").
    if (/^[a-z0-9][a-z0-9 ._/-]*$/.test(kw)) {
      const pattern = wholeWordPattern(kw);
      return pattern.test(normalized) || pattern.test(localizedNormalized);
    }
    // Keywords run through the same locale-aware normalization as the
    // utterance, so a keyword authored as "スラック" still matches "すらっく"
    // input (and vice versa) and request endings on either side peel equally.
    // A keyword that normalizes to empty (punctuation-only) must not become a
    // universal includes('') match.
    const normalizedKeyword = normalizeForTriggerMatchCached(kw);
    return (
      normalized.includes(kw) ||
      (normalizedKeyword.length >= 2 && localizedNormalized.includes(normalizedKeyword)) ||
      // A keyword ending-strip can collapse to one char ("押して" -> "押") —
      // still useful, but only as an exact token so 押印/押さえて don't fire it.
      (normalizedKeyword.length === 1 && utteranceTokens.includes(normalizedKeyword))
    );
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

  const exampleTokens = new Set(
    (intent.surface_examples || []).flatMap((example) => tokenize(example))
  );
  // Distinct tokens only — an utterance repeating one word must not satisfy
  // the two-token floor below with a single shared term.
  const overlap = [...new Set(utteranceTokens)].filter((token) => exampleTokens.has(token));
  // A single shared word is weak evidence — common verbs (まとめ, 作成) recur
  // across unrelated intents and would hijack the ranking on a one-token hit.
  if (overlap.length >= 2) {
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
  const candidate: IntentResolutionCandidate = {
    intent_id: intent.id,
    confidence: Number(score.toFixed(2)),
    source: matchedKeywords.length > 0 ? 'heuristic' : 'catalog',
    matched_keywords: matchedKeywords,
    reasons,
    resolution: intent.resolution,
  };
  if (keywordFrequency) {
    candidateSpecificity.set(
      candidate,
      matchedKeywords.reduce(
        (sum, keyword) =>
          sum + 1 / Math.max(keywordFrequency(String(keyword)), 1) + keyword.length * 0.001,
        0
      )
    );
  }
  return candidate;
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
  if (matchesIntentPhrase(normalized, 'schedule.agenda_non_calendar_object')) return null;
  if (isDocumentProjectRequest(utterance)) return null;

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
  const normalized = normalizeForTriggerMatchCached(utterance);
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
  const normalized = normalizeForTriggerMatchCached(utterance);
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
  owner: 'libs/core/intent/intent-resolution.ts',
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
  const catalog = loadResolvedStandardIntentCatalog(options);
  const surfaceIntents = catalog.filter((intent) => {
    if (!intent.id) return false;
    const ontologyEntry = ontology.get(intent.id);
    if (ontologyEntry) return ontologyEntry.exposed_to_surface !== false;
    if (typeof intent.exposed_to_surface === 'boolean') return intent.exposed_to_surface;
    return intent.category === scoringPolicy.catalog_intent_category;
  });
  const keywordFrequency = cachedKeywordDocumentFrequency(catalog, surfaceIntents);
  const candidates = [
    ...surfaceIntents
      .map((intent) => scoreCatalogIntent(trimmed, intent, keywordFrequency))
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

  // Semantic artifact-project evidence may outrank topic-word matches, but
  // never demote a viable high-stakes incident/security candidate.
  const highStakesIntents = new Set(
    surfaceIntents
      .filter((intent) => intent.risk_profile === 'high_stakes')
      .map((intent) => intent.id)
  );
  const hasHighStakesCandidate = candidates.some(
    (candidate) =>
      highStakesIntents.has(candidate.intent_id) &&
      candidate.confidence >= scoringPolicy.selected_confidence_threshold
  );
  const leadingCandidate = candidates.reduce<IntentResolutionCandidate | undefined>(
    (leading, candidate) =>
      !leading ||
      candidate.confidence > leading.confidence ||
      (candidate.confidence === leading.confidence &&
        (candidateSpecificity.get(candidate) || 0) > (candidateSpecificity.get(leading) || 0))
        ? candidate
        : leading,
    undefined
  );
  const leadingIntent = surfaceIntents.find((intent) => intent.id === leadingCandidate?.intent_id);
  const preserveApprovalRequiredSelection =
    leadingIntent?.id !== 'bootstrap-project' &&
    leadingIntent?.risk_profile === 'approval_required';
  if (
    !hasHighStakesCandidate &&
    !preserveApprovalRequiredSelection &&
    isDocumentProjectRequest(trimmed)
  ) {
    const project = surfaceIntents.find((intent) => intent.id === 'bootstrap-project');
    const existing = candidates.find((candidate) => candidate.intent_id === project?.id);
    if (project) {
      candidates.push({
        intent_id: project.id,
        confidence: Math.max(existing?.confidence || 0, scoringPolicy.keyword_max_confidence),
        source: 'heuristic',
        matched_keywords: existing?.matched_keywords || [],
        reasons: [
          ...(existing?.reasons || []),
          'explicit new project with a document creation outcome',
        ],
        resolution: project.resolution,
      });
    }
  }

  const deduped = new Map<string, IntentResolutionCandidate>();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.intent_id);
    if (!existing || existing.confidence < candidate.confidence) {
      deduped.set(candidate.intent_id, candidate);
    }
  }

  const sorted = [...deduped.values()].sort(
    (left, right) =>
      right.confidence - left.confidence ||
      (candidateSpecificity.get(right) || 0) - (candidateSpecificity.get(left) || 0)
  );
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
