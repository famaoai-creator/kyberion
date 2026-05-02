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
} from '@agent/core';
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
  authority: string;
  phase: string[];
  applies_to: string[];
  owner?: string;
  knowledge_type?: string;
  intelligence_layer?: string;
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
  authority: number;
}

interface ScoredEntry extends KnowledgeEntry {
  score: number;
  breakdown: {
    intent: number;
    role: number;
    phase: number;
    scope: number;
    kind: number;
    authority: number;
    importance: number;
    recency: number;
  };
}

interface TaxonomyManifest {
  kinds?: Record<string, {
    default_authority?: string;
    default_scope?: string;
  }>;
  directory_defaults?: Array<{
    path_prefix: string;
    kind: string;
    authority: string;
    scope: string;
  }>;
  retrieval_priority?: Record<string, string[]>;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => String(item).trim()).filter(Boolean)
    : typeof value === 'string' && value.trim()
      ? [value.trim()]
      : [];
}

let cachedTaxonomy: TaxonomyManifest | null = null;

function loadTaxonomy(): TaxonomyManifest {
  if (cachedTaxonomy) return cachedTaxonomy;
  const taxonomyPath = pathResolver.knowledge('public/governance/knowledge-taxonomy.json');
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
  return defaults.find(entry => normalized.startsWith(entry.path_prefix));
}

function inferKind(relativePath: string, frontmatter: Record<string, any>): string {
  if (typeof frontmatter.kind === 'string' && frontmatter.kind.trim()) return frontmatter.kind.trim();
  return resolveDirectoryDefault(relativePath)?.kind || 'reference';
}

function inferScope(frontmatter: Record<string, any>): string {
  if (typeof frontmatter.scope === 'string' && frontmatter.scope.trim()) return frontmatter.scope.trim();
  const kind = typeof frontmatter.kind === 'string' && frontmatter.kind.trim()
    ? frontmatter.kind
    : undefined;
  return (kind && loadTaxonomy().kinds?.[kind]?.default_scope) || 'global';
}

function inferAuthority(relativePath: string, frontmatter: Record<string, any>): string {
  if (typeof frontmatter.authority === 'string' && frontmatter.authority.trim()) return frontmatter.authority.trim();
  const directoryDefault = resolveDirectoryDefault(relativePath);
  if (directoryDefault?.authority) return directoryDefault.authority;
  const kind = typeof frontmatter.kind === 'string' ? frontmatter.kind : inferKind(relativePath, frontmatter);
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
      value = value.slice(1, -1).split(',').map((s: string) => s.trim().replace(/^['"]|['"]$/g, ''));
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
function scanKnowledgeFiles(): KnowledgeEntry[] {
  const knowledgeRoot = pathResolver.knowledge();
  const entries: KnowledgeEntry[] = [];

  function walk(dir: string) {
    if (!safeExistsSync(dir)) return;
    let items: string[];
    try { items = safeReaddir(dir); } catch (_) { return; }
    for (const item of items) {
      const fullPath = path.join(dir, item);
      let stat: ReturnType<typeof safeStat>;
      try { stat = safeStat(fullPath); } catch (_) { continue; }
      if (stat.isDirectory()) {
        // Skip hidden dirs, node_modules, external-wisdom
        if (item.startsWith('.') || item === 'node_modules' || item === 'external-wisdom') continue;
        walk(fullPath);
      } else if (stat.isFile() && item.endsWith('.md') && !item.startsWith('_')) {
        try {
          const content = safeReadFile(fullPath, { encoding: 'utf8' }) as string;
          const fm = parseFrontmatter(content);
          const relativePath = path.relative(knowledgeRoot, fullPath);
          const tier = relativePath.startsWith('personal/')
            ? 'personal'
            : relativePath.startsWith('confidential/')
              ? 'confidential'
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
            authority: inferAuthority(relativePath, fm),
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
  return text.toLowerCase().split(/[\s\-_/,;:]+/).filter(t => t.length > 1);
}

export function scoreEntry(
  entry: KnowledgeEntry,
  intentTokens: string[],
  roleSlug: string,
  phaseSlug: string,
  currentScope: string,
  weights: RankingWeights,
  now: number,
): ScoredEntry {
  // 1. Intent Match — title + tags
  const titleTokens = tokenize(entry.title);
  const tagTokens = entry.tags.map(t => t.toLowerCase());
  const pathTokens = tokenize(entry.path);

  let intentScore = 0;
  for (const token of intentTokens) {
    if (titleTokens.some(t => t.includes(token))) intentScore += weights.title;
    if (tagTokens.some(t => t.includes(token))) intentScore += weights.tag;
    if (pathTokens.some(t => t.includes(token))) intentScore += weights.category;
  }

  // 2. Role Match
  let roleScore = 0;
  const roleCandidates = [...entry.related_roles, ...entry.role_affinity];
  if (roleSlug && roleCandidates.length > 0) {
    const normalizedRoles = roleCandidates.map(r => r.toLowerCase().replace(/\s+/g, '_'));
    if (normalizedRoles.some(r => r.includes(roleSlug))) {
      roleScore = weights.role;
    }
  }

  const taxonomy = loadTaxonomy();
  let phaseScore = 0;
  if (phaseSlug) {
    const normalizedPhases = entry.phase.map(p => p.toLowerCase());
    if (normalizedPhases.includes(phaseSlug)) {
      phaseScore = weights.phase;
    }
  }

  let scopeScore = 0;
  const scopeMatrix: Record<string, Record<string, number>> = {
    global: { global: 1, repository: 0.6, mission: 0.4, environment: 0.2 },
    repository: { global: 0.7, repository: 1, mission: 0.8, environment: 0.3 },
    mission: { global: 0.5, repository: 0.8, mission: 1, environment: 0.4 },
    environment: { global: 0.3, repository: 0.4, mission: 0.5, environment: 1 },
  };
  scopeScore = Math.round(weights.scope * (scopeMatrix[currentScope]?.[entry.scope] ?? 0.4));

  let kindScore = 0;
  if (phaseSlug) {
    const preferredKinds = taxonomy.retrieval_priority?.[phaseSlug] || [];
    const kindIndex = preferredKinds.indexOf(entry.kind);
    if (kindIndex >= 0) {
      kindScore = Math.max(1, weights.kind - kindIndex * 2);
    }
  }

  const authorityWeights: Record<string, number> = {
    policy: weights.authority,
    standard: Math.max(1, weights.authority - 1),
    recipe: Math.max(1, weights.authority - 2),
    reference: Math.max(1, weights.authority - 4),
    advisory: Math.max(1, weights.authority - 5),
  };
  const authorityScore = authorityWeights[entry.authority] || 0;

  // 3. Importance (normalize to 0-10 scale)
  const importanceScore = entry.importance;

  // 4. Recency (days since last update, decayed)
  const lastUpdated = new Date(entry.last_updated).getTime();
  const daysSince = Math.max(0, (now - lastUpdated) / (1000 * 60 * 60 * 24));
  const recencyScore = Math.max(0, 10 - daysSince / 30); // Lose ~1 point per month

  const total = intentScore + roleScore + phaseScore + scopeScore + kindScore + authorityScore + importanceScore + recencyScore;

  return {
    ...entry,
    score: total,
    breakdown: {
      intent: intentScore,
      role: roleScore,
      phase: phaseScore,
      scope: scopeScore,
      kind: kindScore,
      authority: authorityScore,
      importance: importanceScore,
      recency: Math.round(recencyScore * 100) / 100,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function loadWeights(): RankingWeights {
  const configPath = pathResolver.knowledge('public/governance/analysis-config.json');
  const defaults: RankingWeights = { title: 10, id: 5, tag: 15, category: 3, role: 25, phase: 18, scope: 12, kind: 10, authority: 8 };
  if (!safeExistsSync(configPath)) return defaults;
  try {
    const config = readJsonFile<any>(configPath);
    return { ...defaults, ...config.algorithms?.ranking?.weights };
  } catch (_) {
    return defaults;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const intentIdx = args.indexOf('--intent');
  const roleIdx = args.indexOf('--role');
  const phaseIdx = args.indexOf('--phase');
  const scopeIdx = args.indexOf('--scope');
  const limitIdx = args.indexOf('--limit');
  const jsonFlag = args.includes('--json');

  const intent = intentIdx >= 0 ? args[intentIdx + 1] : '';
  const role = roleIdx >= 0 ? args[roleIdx + 1] : '';
  const phase = phaseIdx >= 0 ? args[phaseIdx + 1] : '';
  const scope = scopeIdx >= 0 ? args[scopeIdx + 1] : 'repository';
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 7;

  if (!intent) {
    console.log('Usage: node dist/scripts/context_ranker.js --intent "query" [--role "role"] [--phase "alignment"] [--scope "repository"] [--limit N] [--json]');
    process.exit(1);
  }

  logger.info(`🔍 [ContextRanker] Ranking knowledge for intent="${intent}", role="${role}", phase="${phase}", scope="${scope}", limit=${limit}`);

  const weights = loadWeights();
  const entries = scanKnowledgeFiles();
  const intentTokens = tokenize(intent);
  const roleSlug = role.toLowerCase().replace(/\s+/g, '_');
  const phaseSlug = phase.toLowerCase().trim();
  const now = Date.now();

  const scored = entries
    .map(e => scoreEntry(e, intentTokens, roleSlug, phaseSlug, scope, weights, now))
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (jsonFlag) {
    console.log(JSON.stringify({ intent, role, phase, scope, limit, results: scored }, null, 2));
  } else {
    logger.info(`📊 TOP-${limit} Results (${scored.length} matches from ${entries.length} files):`);
    for (let i = 0; i < scored.length; i++) {
      const e = scored[i];
      const breakdown = `intent=${e.breakdown.intent} role=${e.breakdown.role} phase=${e.breakdown.phase} scope=${e.breakdown.scope} kind=${e.breakdown.kind} auth=${e.breakdown.authority} imp=${e.breakdown.importance} rec=${e.breakdown.recency}`;
      logger.info(`  ${i + 1}. [${e.score.toFixed(1)}] ${e.path} (${breakdown})`);
    }
  }
}

// Only run when executed directly (not when imported by tests)
const isDirectRun = process.argv[1]?.includes('context_ranker');
if (isDirectRun) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
