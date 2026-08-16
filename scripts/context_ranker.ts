/**
 * scripts/context_ranker.ts
 * Kyberion Context Ranker v1.0
 *
 * Identifies the TOP-N most relevant knowledge files for a given intent and role.
 * Used during Phase ③ Alignment to minimize noise.
 *
 * Algorithm (from knowledge_management.md §4):
 *   1. Intent Match  — intent words vs title & tags
 *   2. Role Match    — active role vs related_roles
 *   3. Importance    — importance metadata value
 *   4. Recency       — freshness based on last_updated
 *
 * Weights are loaded from governance/analysis-config.json.
 *
 * Usage:
 *   node dist/scripts/context_ranker.js --intent "mission governance" --role "ceo" --limit 7
 */

import * as path from 'node:path';
import {
  logger,
  pathResolver,
  safeReaddir,
  safeReadFile,
  safeExistsSync,
  safeStat,
  scopeAffinityScore,
  docAuthorityScore,
  recencyDecayScore,
  currentScope,
  resolveKnowledgeScopeSet,
  assertKnowledgePathInScope,
  knowledgeScopeProximityScore,
  loadKnowledgeUsageAggregate,
  loadKnowledgeRankingWeights,
} from '@agent/core';
import type { ScopeContext } from '@agent/core';
import { readJsonFile } from './refactor/cli-input.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface KnowledgeEntry {
  path: string;
  title: string;
  tags: string[];
  importance: number;
  related_roles: string[];
  role_affinity: string[];
  last_updated: string;
  tier: string;
  kind: string;
  scope: string;
  /** Document authority level (policy/standard/recipe/reference/advisory). NOT the runtime Authority type. */
  docAuthority: string;
  phase: string[];
  applies_to: string[];
  owner?: string;
  knowledge_type?: string;
  intelligence_layer?: string;
  usage_yield?: number;
}

export interface RankingWeights {
  title: number;
  id: number;
  tag: number;
  category: number;
  role: number;
  phase: number;
  scope: number;
  kind: number;
  /** Weight for docAuthority ranking (policy > standard > recipe > reference > advisory). */
  authority: number;
  /** Weight for containment proximity (task > mission > project > org > tenant). */
  proximity: number;
  /** Small configurable boost for documents that users marked useful. */
  usage_yield: number;
}

interface ScoredEntry extends KnowledgeEntry {
  score: number;
  breakdown: {
    intent: number;
    role: number;
    phase: number;
    scope: number;
    kind: number;
    docAuthority: number;
    importance: number;
    recency: number;
    proximity: number;
    usageYield: number;
  };
}

interface TaxonomyManifest {
  kinds?: Record<
    string,
    {
      default_authority?: string;
      default_scope?: string;
    }
  >;
  directory_defaults?: Array<{
    path_prefix: string;
    kind: string;
    authority: string;
    scope: string;
  }>;
  retrieval_priority?: Record<string, string[]>;
}

export interface KnowledgeScanStats {
  scanned_files: number;
  in_scope_files: number;
  excluded_by_scope: number;
  knowledge_roots: string[];
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : typeof value === 'string' && value.trim()
      ? [value.trim()]
      : [];
}

let cachedTaxonomy: TaxonomyManifest | null = null;

function loadTaxonomy(): TaxonomyManifest {
  if (cachedTaxonomy) return cachedTaxonomy;
  const taxonomyPath = pathResolver.knowledge('product/governance/knowledge-taxonomy.json');
  if (!safeExistsSync(taxonomyPath)) {
    cachedTaxonomy = {};
    return cachedTaxonomy;
  }

  try {
    cachedTaxonomy = readJsonFile<TaxonomyManifest>(taxonomyPath);
  } catch (_) {
    cachedTaxonomy = {};
  }

  return cachedTaxonomy;
}

function resolveDirectoryDefault(relativePath: string) {
  const normalized = path.join('knowledge', relativePath).replace(/\\/g, '/');
  const defaults = loadTaxonomy().directory_defaults || [];
  return defaults.find((entry) => normalized.startsWith(entry.path_prefix));
}

function inferKind(relativePath: string, frontmatter: Record<string, any>): string {
  if (typeof frontmatter.kind === 'string' && frontmatter.kind.trim())
    return frontmatter.kind.trim();
  return resolveDirectoryDefault(relativePath)?.kind || 'reference';
}

function inferScope(frontmatter: Record<string, any>): string {
  if (typeof frontmatter.scope === 'string' && frontmatter.scope.trim())
    return frontmatter.scope.trim();
  const kind =
    typeof frontmatter.kind === 'string' && frontmatter.kind.trim() ? frontmatter.kind : undefined;
  return (kind && loadTaxonomy().kinds?.[kind]?.default_scope) || 'global';
}

function inferDocAuthority(relativePath: string, frontmatter: Record<string, any>): string {
  if (typeof frontmatter.docAuthority === 'string' && frontmatter.docAuthority.trim())
    return frontmatter.docAuthority.trim();
  if (typeof frontmatter.authority === 'string' && frontmatter.authority.trim())
    return frontmatter.authority.trim();
  const directoryDefault = resolveDirectoryDefault(relativePath);
  if (directoryDefault?.authority) return directoryDefault.authority;
  const kind =
    typeof frontmatter.kind === 'string' ? frontmatter.kind : inferKind(relativePath, frontmatter);
  return loadTaxonomy().kinds?.[kind]?.default_authority || 'reference';
}

// ---------------------------------------------------------------------------
// Frontmatter Parser
// ---------------------------------------------------------------------------
export function parseFrontmatter(content: string): Record<string, any> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const lines = match[1].split('\n');
  const result: Record<string, any> = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: any = line.slice(colonIdx + 1).trim();
    // Parse arrays like [a, b, c]
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((s: string) => s.trim().replace(/^['"]|['"]$/g, ''));
    }
    // Parse numbers
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      value = parseInt(value, 10);
    }
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Knowledge Scanner
// ---------------------------------------------------------------------------
export function scanKnowledgeFiles(
  scopeSet = resolveKnowledgeScopeSet(currentScope()),
  stats?: KnowledgeScanStats
): KnowledgeEntry[] {
  const knowledgeRoot = pathResolver.knowledge();
  const entries: KnowledgeEntry[] = [];
  if (stats) {
    stats.knowledge_roots = [...scopeSet.roots];
    stats.scanned_files = 0;
    stats.in_scope_files = 0;
    stats.excluded_by_scope = 0;
  }

  function walk(dir: string) {
    if (!safeExistsSync(dir)) return;
    let items: string[];
    try {
      items = safeReaddir(dir);
    } catch (_) {
      return;
    }
    for (const item of items) {
      const fullPath = path.join(dir, item);
      let stat: ReturnType<typeof safeStat>;
      try {
        stat = safeStat(fullPath);
      } catch (_) {
        continue;
      }
      if (stat.isDirectory()) {
        // Skip hidden dirs, node_modules, external-wisdom
        if (item.startsWith('.') || item === 'node_modules' || item === 'external-wisdom') continue;
        walk(fullPath);
      } else if (stat.isFile() && item.endsWith('.md') && !item.startsWith('_')) {
        try {
          const relativePath = path.relative(knowledgeRoot, fullPath);
          if (stats) stats.scanned_files += 1;
          if (!assertKnowledgePathInScope(relativePath, scopeSet)) {
            if (stats) stats.excluded_by_scope += 1;
            continue;
          }
          if (stats) stats.in_scope_files += 1;
          const content = safeReadFile(fullPath, { encoding: 'utf8' }) as string;
          const fm = parseFrontmatter(content);
          const tier = relativePath.startsWith('personal/')
            ? 'personal'
            : relativePath.startsWith('confidential/')
              ? 'confidential'
              : relativePath.startsWith('product/')
                ? 'product'
                : 'public';

          entries.push({
            path: relativePath,
            title: fm.title || path.basename(fullPath, '.md'),
            tags: Array.isArray(fm.tags) ? fm.tags : [],
            importance: typeof fm.importance === 'number' ? fm.importance : 3,
            related_roles: Array.isArray(fm.related_roles) ? fm.related_roles : [],
            role_affinity: normalizeStringArray(fm.role_affinity),
            last_updated: fm.last_updated || '2020-01-01',
            tier,
            kind: inferKind(relativePath, fm),
            scope: inferScope(fm),
            docAuthority: inferDocAuthority(relativePath, fm),
            phase: normalizeStringArray(fm.phase),
            applies_to: normalizeStringArray(fm.applies_to),
            owner: typeof fm.owner === 'string' ? fm.owner : undefined,
            knowledge_type: fm.knowledge_type,
            intelligence_layer: fm.intelligence_layer,
          });
        } catch (_) {
          // Skip unreadable files
        }
      }
    }
  }

  walk(knowledgeRoot);
  return entries;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_/,;:]+/)
    .filter((t) => t.length > 1);
}

export function scoreEntry(
  entry: KnowledgeEntry,
  intentTokens: string[],
  roleSlug: string,
  phaseSlug: string,
  currentScope: string,
  weights: RankingWeights,
  now: number,
  currentScopeContext?: ScopeContext,
  usageYield = 0
): ScoredEntry {
  // 1. Intent Match — title + tags
  const titleTokens = tokenize(entry.title);
  const tagTokens = entry.tags.map((t) => t.toLowerCase());
  const pathTokens = tokenize(entry.path);

  let intentScore = 0;
  for (const token of intentTokens) {
    if (titleTokens.some((t) => t.includes(token))) intentScore += weights.title;
    if (tagTokens.some((t) => t.includes(token))) intentScore += weights.tag;
    if (pathTokens.some((t) => t.includes(token))) intentScore += weights.category;
  }

  // 2. Role Match
  let roleScore = 0;
  const roleCandidates = [...entry.related_roles, ...entry.role_affinity];
  if (roleSlug && roleCandidates.length > 0) {
    const normalizedRoles = roleCandidates.map((r) => r.toLowerCase().replace(/\s+/g, '_'));
    if (normalizedRoles.some((r) => r.includes(roleSlug))) {
      roleScore = weights.role;
    }
  }

  const taxonomy = loadTaxonomy();
  let phaseScore = 0;
  if (phaseSlug) {
    const normalizedPhases = entry.phase.map((p) => p.toLowerCase());
    if (normalizedPhases.includes(phaseSlug)) {
      phaseScore = weights.phase;
    }
  }

  const scopeScore = scopeAffinityScore(currentScope, entry.scope, weights.scope);
  // Keep direct callers compatible with pre-proximity ranking weight objects.
  // CLI-loaded weights always contain these fields, but tests and integrations
  // may provide the older shape; undefined * a number would poison the total
  // with NaN instead of simply omitting the newer signal.
  const proximityWeight = Number.isFinite(weights.proximity) ? weights.proximity : 0;
  const proximityScore =
    knowledgeScopeProximityScore({ source: entry.path }, currentScopeContext) * proximityWeight;

  let kindScore = 0;
  if (phaseSlug) {
    const preferredKinds = taxonomy.retrieval_priority?.[phaseSlug] || [];
    const kindIndex = preferredKinds.indexOf(entry.kind);
    if (kindIndex >= 0) {
      kindScore = Math.max(1, weights.kind - kindIndex * 2);
    }
  }

  const authorityScore = docAuthorityScore(entry.docAuthority, weights.authority);
  const usageYieldWeight = Number.isFinite(weights.usage_yield) ? weights.usage_yield : 0;
  const usageYieldScore = usageYield * usageYieldWeight;

  // 3. Importance (normalize to 0-10 scale)
  const importanceScore = entry.importance;

  // 4. Recency (days since last update, decayed)
  const recencyScore = recencyDecayScore(new Date(entry.last_updated).getTime(), now);

  const total =
    intentScore +
    roleScore +
    phaseScore +
    scopeScore +
    proximityScore +
    kindScore +
    authorityScore +
    importanceScore +
    recencyScore +
    usageYieldScore;

  return {
    ...entry,
    score: total,
    breakdown: {
      intent: intentScore,
      role: roleScore,
      phase: phaseScore,
      scope: scopeScore,
      proximity: proximityScore,
      kind: kindScore,
      docAuthority: authorityScore,
      importance: importanceScore,
      recency: Math.round(recencyScore * 100) / 100,
      usageYield: Math.round(usageYieldScore * 100) / 100,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function loadWeights(scope?: ScopeContext): RankingWeights {
  const configPath = pathResolver.knowledge('product/governance/analysis-config.json');
  const defaults: RankingWeights = {
    title: 10,
    id: 5,
    tag: 15,
    category: 3,
    role: 25,
    phase: 18,
    scope: 12,
    kind: 10,
    authority: 8,
    proximity: 1,
    usage_yield: 4,
  };
  if (!safeExistsSync(configPath)) return { ...defaults, ...loadKnowledgeRankingWeights(scope) };
  try {
    const config = readJsonFile<any>(configPath);
    return {
      ...defaults,
      ...config.algorithms?.ranking?.weights,
      ...loadKnowledgeRankingWeights(scope),
    };
  } catch (_) {
    return { ...defaults, ...loadKnowledgeRankingWeights(scope) };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const intentIdx = args.indexOf('--intent');
  const roleIdx = args.indexOf('--role');
  const phaseIdx = args.indexOf('--phase');
  const scopeIdx = args.indexOf('--scope');
  const tenantIdx = args.indexOf('--tenant');
  const organizationIdx = args.indexOf('--organization');
  const projectIdx = args.indexOf('--project');
  const missionIdx = args.indexOf('--mission');
  const taskIdx = args.indexOf('--task');
  const limitIdx = args.indexOf('--limit');
  const jsonFlag = args.includes('--json');
  const explainFlag = args.includes('--explain');

  const intent = intentIdx >= 0 ? args[intentIdx + 1] : '';
  const role = roleIdx >= 0 ? args[roleIdx + 1] : '';
  const phase = phaseIdx >= 0 ? args[phaseIdx + 1] : '';
  const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : 'repository';
  const tenant = tenantIdx >= 0 ? args[tenantIdx + 1] : undefined;
  const organization = organizationIdx >= 0 ? args[organizationIdx + 1] : undefined;
  const project = projectIdx >= 0 ? args[projectIdx + 1] : undefined;
  const mission = missionIdx >= 0 ? args[missionIdx + 1] : undefined;
  const task = taskIdx >= 0 ? args[taskIdx + 1] : undefined;
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 7;

  if (!intent) {
    console.log(
      'Usage: node dist/scripts/context_ranker.js --intent "query" [--role "role"] [--phase "alignment"] [--scope "repository"] [--tenant slug] [--organization id] [--project id] [--mission id] [--task id] [--limit N] [--explain] [--json]'
    );
    process.exit(1);
  }

  logger.info(
    `🔍 [ContextRanker] Ranking knowledge for intent="${intent}", role="${role}", phase="${phase}", scope="${scope}", limit=${limit}`
  );

  const resolvedScope = currentScope({
    tier: tenant ? 'confidential' : currentScope().tier,
    ...(tenant ? { tenant_slug: tenant } : {}),
    ...(organization ? { organization_id: organization } : {}),
    ...(project ? { project_id: project } : {}),
    ...(mission ? { mission_id: mission } : {}),
    ...(task ? { task_id: task } : {}),
  });
  const weights = loadWeights(resolvedScope);
  const knowledgeScope = resolveKnowledgeScopeSet(resolvedScope);
  const scanStats: KnowledgeScanStats = {
    scanned_files: 0,
    in_scope_files: 0,
    excluded_by_scope: 0,
    knowledge_roots: [],
  };
  const entries = scanKnowledgeFiles(knowledgeScope, scanStats);
  const usageByPath = new Map(
    loadKnowledgeUsageAggregate(resolvedScope).map((entry) => {
      const total = entry.used_count + entry.not_used_count;
      return [entry.document_path, total > 0 ? entry.used_count / total : 0] as const;
    })
  );
  const scopeWarnings: string[] = [];
  if (resolvedScope.tier === 'confidential' && !resolvedScope.tenant_slug) {
    scopeWarnings.push(
      'confidential scope has no tenant_slug; tenant knowledge roots are unavailable'
    );
  }
  if (
    resolvedScope.tier !== 'public' &&
    resolvedScope.tenant_slug &&
    !knowledgeScope.roots.some((root) =>
      root.startsWith(`${resolvedScope.tier}/${resolvedScope.tenant_slug}`)
    )
  ) {
    scopeWarnings.push(
      `no ${resolvedScope.tier} knowledge root resolved for tenant '${resolvedScope.tenant_slug}'`
    );
  }
  const intentTokens = tokenize(intent);
  const roleSlug = role.toLowerCase().replace(/\s+/g, '_');
  const phaseSlug = phase.toLowerCase().trim();
  const now = Date.now();

  const scored = entries
    .map((e) =>
      scoreEntry(
        e,
        intentTokens,
        roleSlug,
        phaseSlug,
        scope,
        weights,
        now,
        resolvedScope,
        usageByPath.get(e.path) || 0
      )
    )
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (jsonFlag) {
    console.log(
      JSON.stringify(
        {
          intent,
          role,
          phase,
          scope,
          limit,
          knowledge_scope: knowledgeScope,
          ...(explainFlag ? { scope_explain: { ...scanStats, warnings: scopeWarnings } } : {}),
          results: scored,
        },
        null,
        2
      )
    );
  } else {
    logger.info(`📊 TOP-${limit} Results (${scored.length} matches from ${entries.length} files):`);
    if (explainFlag) {
      logger.info(
        `🔐 Scope: scanned=${scanStats.scanned_files} in_scope=${scanStats.in_scope_files} excluded=${scanStats.excluded_by_scope} roots=${scanStats.knowledge_roots.join(',') || '(none)'}`
      );
      for (const warning of scopeWarnings) logger.warn(`⚠️ ${warning}`);
    }
    for (let i = 0; i < scored.length; i++) {
      const e = scored[i];
      const breakdown = `intent=${e.breakdown.intent} role=${e.breakdown.role} phase=${e.breakdown.phase} scope=${e.breakdown.scope} proximity=${e.breakdown.proximity} kind=${e.breakdown.kind} auth=${e.breakdown.docAuthority} imp=${e.breakdown.importance} rec=${e.breakdown.recency}`;
      logger.info(`  ${i + 1}. [${e.score.toFixed(1)}] ${e.path} (${breakdown})`);
    }
  }
}

// Only run when executed directly (not when imported by tests)
const isDirectRun = process.argv[1]?.includes('context_ranker');
if (isDirectRun) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}
