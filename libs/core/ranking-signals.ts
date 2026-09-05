/**
 * Shared ranking signals (KM-02 Task 4).
 *
 * Two rankers coexist: scripts/context_ranker.ts (pipeline-facing document
 * ranking CLI) and libs/core/src/knowledge-index.ts (runtime retrieval).
 * Their scoring definitions historically lived inline in each, so a tuning
 * fix in one never reached the other. The formulas below are the single
 * source of truth; both rankers import them. Full unification (making the
 * CLI a wrapper over the runtime index) is recorded in the KM-02 plan as
 * the next step.
 */

import { defineCatalog } from './foundation/governed-catalog.js';
import { clamp } from './foundation/text.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync } from './secure-io.js';
import type { ScopeContext } from './scope-context.js';

/** Cross-scope affinity: how relevant an entry of scope X is when ranking for scope Y. */
export type ScopeAffinityMatrix = Record<string, Record<string, number>>;

export const DEFAULT_SCOPE_AFFINITY: ScopeAffinityMatrix = {
  global: { global: 1, repository: 0.6, mission: 0.4, environment: 0.2 },
  repository: { global: 0.7, repository: 1, mission: 0.8, environment: 0.3 },
  mission: { global: 0.5, repository: 0.8, mission: 1, environment: 0.4 },
  environment: { global: 0.3, repository: 0.4, mission: 0.5, environment: 1 },
};

/** Affinity used when either scope is unknown to the matrix. */
export const SCOPE_AFFINITY_FALLBACK = 0.4;

export function scopeAffinityScore(
  currentScope: string,
  entryScope: string,
  scopeWeight: number,
  matrix: ScopeAffinityMatrix = DEFAULT_SCOPE_AFFINITY
): number {
  const affinity = matrix[currentScope]?.[entryScope] ?? SCOPE_AFFINITY_FALLBACK;
  return Math.round(scopeWeight * affinity);
}

/**
 * Document-authority ladder. Offsets are subtracted from the configured
 * authority weight; every recognised level scores at least 1 so a governed
 * document never ties with an unclassified one.
 */
export const DOC_AUTHORITY_OFFSETS: Record<string, number> = {
  policy: 0,
  standard: 1,
  recipe: 2,
  reference: 4,
  advisory: 5,
};

export function docAuthorityScore(docAuthority: string, authorityWeight: number): number {
  const offset = DOC_AUTHORITY_OFFSETS[docAuthority];
  if (offset === undefined) return 0;
  return offset === 0 ? authorityWeight : Math.max(1, authorityWeight - offset);
}

export interface RecencyDecayOptions {
  /** Score when the document was updated just now. Default 10. */
  maxScore?: number;
  /** Days it takes to lose one point. Default 30 (~1 point per month). */
  decayDaysPerPoint?: number;
}

export function recencyDecayScore(
  lastUpdatedMs: number,
  nowMs: number,
  options: RecencyDecayOptions = {}
): number {
  const maxScore = options.maxScore ?? 10;
  const decayDaysPerPoint = options.decayDaysPerPoint ?? 30;
  if (!Number.isFinite(lastUpdatedMs)) return 0;
  const daysSince = Math.max(0, (nowMs - lastUpdatedMs) / (1000 * 60 * 60 * 24));
  return Math.max(0, maxScore - daysSince / decayDaysPerPoint);
}

export interface KnowledgeRankingMetadata {
  last_updated?: string;
  doc_authority?: string;
  scope?: string;
  /** Canonical containment scope derived from placement, never user text. */
  scope_context?: ScopeContext;
  /** Knowledge-relative source path used to derive a physical scope. */
  source?: string;
  /** Fraction of explicit useful feedback among feedback events (0..1). */
  usage_yield?: number;
}

export interface KnowledgeRankingWeights {
  scope?: number;
  authority?: number;
  recency?: number;
  proximity?: number;
  usage_yield?: number;
}

export interface KnowledgeRankingWeightConfig {
  version?: string;
  description?: string;
  defaults?: KnowledgeRankingWeights;
  tenant_overrides?: Record<string, KnowledgeRankingWeights>;
}

const KNOWLEDGE_WEIGHTS_PATH = pathResolver.knowledge('product/governance/knowledge-weights.json');
const KNOWLEDGE_WEIGHTS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/knowledge-weights.schema.json'
);
const DEFAULT_KNOWLEDGE_WEIGHTS_CONFIG: KnowledgeRankingWeightConfig = {
  version: '1.0.0',
  defaults: { proximity: 1, usage_yield: 4 },
  tenant_overrides: {},
};

const knowledgeWeightsCatalog = defineCatalog<KnowledgeRankingWeightConfig>({
  id: 'knowledge-weights',
  path: KNOWLEDGE_WEIGHTS_PATH,
  schema: KNOWLEDGE_WEIGHTS_SCHEMA_PATH,
});

export function loadKnowledgeRankingWeightConfig(
  rootPath = KNOWLEDGE_WEIGHTS_PATH,
  fallbackOnInvalid = true
): KnowledgeRankingWeightConfig {
  void fallbackOnInvalid;
  const safeRootPath = assertSafeRepositoryPath(rootPath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeRootPath)) {
    return { ...DEFAULT_KNOWLEDGE_WEIGHTS_CONFIG };
  }
  const catalog =
    safeRootPath === KNOWLEDGE_WEIGHTS_PATH
      ? knowledgeWeightsCatalog
      : defineCatalog<KnowledgeRankingWeightConfig>({
          id: 'knowledge-weights',
          path: safeRootPath,
          schema: KNOWLEDGE_WEIGHTS_SCHEMA_PATH,
        });
  return catalog.load();
}

/** Load governed ranking knobs after the caller has resolved its scope. */
export function loadKnowledgeRankingWeights(
  scope?: ScopeContext,
  rootPath = KNOWLEDGE_WEIGHTS_PATH
): KnowledgeRankingWeights {
  const defaults: KnowledgeRankingWeights = { proximity: 1, usage_yield: 4 };
  const config = loadKnowledgeRankingWeightConfig(rootPath);
  return {
    ...defaults,
    ...(config.defaults || {}),
    ...(scope?.tenant_slug ? config.tenant_overrides?.[scope.tenant_slug] || {} : {}),
  };
}

/**
 * Rank a document by containment proximity.  The values intentionally form a
 * strict ladder so a same-project document cannot lose to a shared document
 * on a lexical tie.  `common` and public/product documents are the baseline.
 */
export function scopeProximityScore(
  documentScope: ScopeContext | undefined,
  currentScope: ScopeContext | undefined
): number {
  if (!currentScope) return 0;
  if (!documentScope) return 1;
  if (documentScope.tenant_slug && documentScope.tenant_slug !== currentScope.tenant_slug) {
    return 0;
  }
  if (documentScope.task_id && documentScope.task_id === currentScope.task_id) return 6;
  if (documentScope.mission_id && documentScope.mission_id === currentScope.mission_id) return 5;
  if (documentScope.project_id && documentScope.project_id === currentScope.project_id) return 4;
  if (
    documentScope.organization_id &&
    documentScope.organization_id === currentScope.organization_id
  )
    return 3;
  if (documentScope.tenant_slug && documentScope.tenant_slug === currentScope.tenant_slug) return 2;
  return 1;
}

/** Derive a physical scope from a knowledge-relative path. */
export function scopeContextFromKnowledgePath(
  source: string,
  tier: ScopeContext['tier'] = 'confidential'
): ScopeContext | undefined {
  const normalized = source.replace(/\\/g, '/').replace(/^\.\.\//, '');
  const match = normalized.match(
    /^(?:knowledge\/)?confidential\/([^/]+)(?:\/organizations\/([^/]+))?(?:\/projects\/([^/]+))?(?:\/missions\/([^/]+))?(?:\/tasks\/([^/]+))?(?:\/sessions\/([^/]+))?(?:\/|$)/
  );
  if (!match || match[1] === 'common') return undefined;
  return {
    tier,
    tenant_slug: match[1],
    ...(match[2] ? { organization_id: match[2] } : {}),
    ...(match[3] ? { project_id: match[3] } : {}),
    ...(match[4] ? { mission_id: match[4] } : {}),
    ...(match[5] ? { task_id: match[5] } : {}),
    ...(match[6] ? { session_id: match[6] } : {}),
  };
}

export function knowledgeScopeProximityScore(
  metadata: KnowledgeRankingMetadata,
  currentScope?: ScopeContext
): number {
  const documentScope =
    metadata.scope_context ||
    (metadata.source ? scopeContextFromKnowledgePath(metadata.source) : undefined);
  return scopeProximityScore(documentScope, currentScope);
}

/**
 * Score the metadata signals shared by runtime knowledge retrieval and the
 * alignment ranker. Missing metadata contributes zero so legacy JSON hints
 * keep their historical ordering until they opt into the richer contract.
 */
export function knowledgeMetadataScore(
  metadata: KnowledgeRankingMetadata,
  currentScope = 'global',
  weights: KnowledgeRankingWeights = {},
  nowMs = Date.now(),
  currentScopeContext?: ScopeContext
): number {
  const scopeWeight = weights.scope ?? 12;
  const authorityWeight = weights.authority ?? 8;
  const recencyWeight = weights.recency ?? 10;
  const proximityWeight = weights.proximity ?? 1;
  const usageYieldWeight = weights.usage_yield ?? 4;
  const scopeScore = metadata.scope
    ? scopeAffinityScore(currentScope, metadata.scope, scopeWeight)
    : 0;
  const authorityScore = metadata.doc_authority
    ? docAuthorityScore(metadata.doc_authority, authorityWeight)
    : 0;
  const recencyScore = metadata.last_updated
    ? recencyDecayScore(Date.parse(metadata.last_updated), nowMs, { maxScore: recencyWeight })
    : 0;
  const proximityScore =
    knowledgeScopeProximityScore(metadata, currentScopeContext) * proximityWeight;
  const usageYieldScore = clamp(metadata.usage_yield ?? 0, 0, 1) * usageYieldWeight;
  return scopeScore + authorityScore + recencyScore + proximityScore + usageYieldScore;
}
