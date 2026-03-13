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
 *   npx tsx scripts/context_ranker.ts --intent "mission governance" --role "ceo" --limit 7
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  logger,
  pathResolver,
  safeReadFile,
  safeExistsSync,
} from '@agent/core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface KnowledgeEntry {
  path: string;
  title: string;
  tags: string[];
  importance: number;
  related_roles: string[];
  last_updated: string;
  tier: string;
  knowledge_type?: string;
  intelligence_layer?: string;
}

export interface RankingWeights {
  title: number;
  id: number;
  tag: number;
  category: number;
  role: number;
}

interface ScoredEntry extends KnowledgeEntry {
  score: number;
  breakdown: {
    intent: number;
    role: number;
    importance: number;
    recency: number;
  };
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
    if (!fs.existsSync(dir)) return;
    let items: string[];
    try { items = fs.readdirSync(dir); } catch (_) { return; }
    for (const item of items) {
      const fullPath = path.join(dir, item);
      let stat: fs.Stats;
      try { stat = fs.lstatSync(fullPath); } catch (_) { continue; }
      if (stat.isDirectory()) {
        // Skip hidden dirs, node_modules, external-wisdom
        if (item.startsWith('.') || item === 'node_modules' || item === 'external-wisdom') continue;
        walk(fullPath);
      } else if (stat.isFile() && item.endsWith('.md') && !item.startsWith('_')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
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
            last_updated: fm.last_updated || '2020-01-01',
            tier,
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
  if (roleSlug && entry.related_roles.length > 0) {
    const normalizedRoles = entry.related_roles.map(r => r.toLowerCase().replace(/\s+/g, '_'));
    if (normalizedRoles.some(r => r.includes(roleSlug))) {
      roleScore = weights.role;
    }
  }

  // 3. Importance (normalize to 0-10 scale)
  const importanceScore = entry.importance;

  // 4. Recency (days since last update, decayed)
  const lastUpdated = new Date(entry.last_updated).getTime();
  const daysSince = Math.max(0, (now - lastUpdated) / (1000 * 60 * 60 * 24));
  const recencyScore = Math.max(0, 10 - daysSince / 30); // Lose ~1 point per month

  const total = intentScore + roleScore + importanceScore + recencyScore;

  return {
    ...entry,
    score: total,
    breakdown: {
      intent: intentScore,
      role: roleScore,
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
  const defaults: RankingWeights = { title: 10, id: 5, tag: 15, category: 3, role: 25 };
  if (!safeExistsSync(configPath)) return defaults;
  try {
    const config = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string);
    return { ...defaults, ...config.algorithms?.ranking?.weights };
  } catch (_) {
    return defaults;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const intentIdx = args.indexOf('--intent');
  const roleIdx = args.indexOf('--role');
  const limitIdx = args.indexOf('--limit');
  const jsonFlag = args.includes('--json');

  const intent = intentIdx >= 0 ? args[intentIdx + 1] : '';
  const role = roleIdx >= 0 ? args[roleIdx + 1] : '';
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 7;

  if (!intent) {
    console.log('Usage: npx tsx scripts/context_ranker.ts --intent "query" [--role "role"] [--limit N] [--json]');
    process.exit(1);
  }

  logger.info(`🔍 [ContextRanker] Ranking knowledge for intent="${intent}", role="${role}", limit=${limit}`);

  const weights = loadWeights();
  const entries = scanKnowledgeFiles();
  const intentTokens = tokenize(intent);
  const roleSlug = role.toLowerCase().replace(/\s+/g, '_');
  const now = Date.now();

  const scored = entries
    .map(e => scoreEntry(e, intentTokens, roleSlug, weights, now))
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (jsonFlag) {
    console.log(JSON.stringify({ intent, role, limit, results: scored }, null, 2));
  } else {
    logger.info(`📊 TOP-${limit} Results (${scored.length} matches from ${entries.length} files):`);
    for (let i = 0; i < scored.length; i++) {
      const e = scored[i];
      const breakdown = `intent=${e.breakdown.intent} role=${e.breakdown.role} imp=${e.breakdown.importance} rec=${e.breakdown.recency}`;
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
