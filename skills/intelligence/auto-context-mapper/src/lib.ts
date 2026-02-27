import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAllFiles } from '@agent/core/fs-utils';

export interface KnowledgeAsset {
  path: string;
  name: string;
  tier: string;
}

export interface ContextLink {
  source: string;
  target: string;
  tier: string;
  type: string;
}

export function scanKnowledgeTiers(dir: string): Record<string, KnowledgeAsset[]> {
  const tiers: Record<string, KnowledgeAsset[]> = { public: [], confidential: [], personal: [] };
  const knowledgeDir = path.join(dir, 'knowledge');
  if (!fs.existsSync(knowledgeDir)) return tiers;

  const allFiles = getAllFiles(knowledgeDir, { maxDepth: 4 });
  for (const full of allFiles) {
    const rel = path.relative(knowledgeDir, full);
    const parts = rel.split(path.sep);

    let tier = 'public';
    if (parts.includes('personal')) tier = 'personal';
    else if (parts.some((p) => ['confidential', 'company', 'client'].includes(p)))
      tier = 'confidential';

    if (['.md', '.json', '.yaml', '.yml'].includes(path.extname(full))) {
      tiers[tier].push({ path: path.relative(dir, full), name: path.basename(full), tier });
    }
  }
  return tiers;
}

export function buildContextMap(
  tiers: Record<string, KnowledgeAsset[]>,
  skills: string[],
  projectRoot: string
): ContextLink[] {
  const links: ContextLink[] = [];
  const allFiles = Object.values(tiers).flat();
  for (const file of allFiles) {
    try {
      const content = fs.readFileSync(path.join(projectRoot, file.path), 'utf8').toLowerCase();
      for (const skill of skills) {
        if (content.includes(skill.toLowerCase())) {
          links.push({ source: file.path, target: skill, tier: file.tier, type: 'references' });
        }
      }
    } catch (_e) {}
  }
  return links;
}
