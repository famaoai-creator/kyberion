/**
 * scripts/context_ranker.ts
 * Ranks knowledge files based on intent and filters out noise.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { logger, safeReadFile, safeWriteFile } from '@agent/core';
import * as pathResolver from '@agent/core/path-resolver';

const indexPath = pathResolver.knowledge('orchestration/knowledge_index.json');

interface KnowledgeItem {
  id: string;
  title: string;
  category: string;
  last_updated?: string;
  score?: number;
}

function detectActiveMission(): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
    if (branch.startsWith('mission/')) {
      return branch.replace('mission/', '').toUpperCase();
    }
  } catch (_) {}
  return process.env.MISSION_ID || null;
}

function getVisionContext(missionId: string): KnowledgeItem | null {
  try {
    const missionDir = pathResolver.missionDir(missionId);
    const statePath = path.join(missionDir, 'mission-state.json');
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.vision_ref) {
        const fullPath = pathResolver.rootDir() + state.vision_ref;
        if (fs.existsSync(fullPath)) {
          return {
            id: 'vision_context',
            title: `Vision: ${state.tenant_id}`,
            category: 'Vision',
            score: 100 // Highest priority
          };
        }
      }
    }
  } catch (_) {}
  return null;
}

export function rankContext(intent: string, limit = 7): KnowledgeItem[] {
  const activeMission = detectActiveMission();
  const visionItem = activeMission ? getVisionContext(activeMission) : null;
  
  if (!fs.existsSync(indexPath)) {
    logger.error('[Ranker] Index not found. Run generate_knowledge_index.ts first.');
    return visionItem ? [visionItem] : [];
  }

  try {
    const indexContent = safeReadFile(indexPath, { encoding: 'utf8' }) as string;
    const index = JSON.parse(indexContent);
    const query = intent.toLowerCase();
    const queryWords = query.split(/[\s,._/-]+/).filter(w => w.length > 2);

    const scoredItems = index.items.map((item: KnowledgeItem) => {
      let score = 0;
      const title = (item.title || '').toLowerCase();
      const id = (item.id || '').toLowerCase();
      const cat = (item.category || '').toLowerCase();

      queryWords.forEach(word => {
        if (title.includes(word)) score += 10;
        if (id.includes(word)) score += 5;
        if (cat.includes(word)) score += 3;
      });

      if (query.includes(cat) || cat.includes(query)) score += 15;
      if (item.last_updated && item.last_updated.startsWith('2026')) score += 2;
      if (id.includes('protocol') || id.includes('policy')) score += 5;

      return { ...item, score };
    });

    const ranked = scoredItems
      .filter((item: any) => item.score > 0)
      .sort((a: any, b: any) => b.score - a.score)
      .slice(0, visionItem ? limit - 1 : limit);

    return visionItem ? [visionItem, ...ranked] : ranked;
  } catch (err: any) {
    logger.error(`Ranking Failed: ${err.message}`);
    return visionItem ? [visionItem] : [];
  }
}

async function main() {
  const intent = process.argv.slice(2).join(' ');
  if (!intent) {
    console.log('Usage: node context_ranker.js "<intent>"');
    process.exit(1);
  }

  const ranked = rankContext(intent);
  console.log(`Context Ranking for: "${intent}"`);
  
  if (ranked.length === 0) {
    console.log('No highly relevant knowledge found.');
  } else {
    ranked.forEach((item, i) => {
      console.log(`${i+1}. [Score: ${item.score}] ${item.title} (${item.id})`);
    });
  }

  const activeContextPath = pathResolver.knowledge('orchestration/active_context.json');
  safeWriteFile(activeContextPath, JSON.stringify({
    intent,
    timestamp: new Date().toISOString(),
    top_matches: ranked
  }, null, 2));
}

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
