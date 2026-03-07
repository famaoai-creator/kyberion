import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { safeWriteFile, safeReadFile } from '@agent/core';

const rootDir = process.cwd();

interface CategoryRule {
  pattern: RegExp;
  cat: string;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  category?: string;
  tags?: string[];
  status?: string;
  last_updated?: string;
  [key: string]: any;
}

interface TagRule {
  keyword: string;
  tag: string;
}

interface TagDictionary {
  rules: TagRule[];
  defaults: string[];
}

const CATEGORY_MAP: CategoryRule[] = [
  {
    pattern: /-connector|-fetcher|-integrator|browser-navigator|box-connector|slack-communicator/,
    cat: 'Integration & API',
  },
  {
    pattern:
      /-auditor|-check|-sentinel|security-scanner|compliance-officer|license-auditor|tier-guard|ip-strategist/,
    cat: 'Governance & Security',
  },
  {
    pattern:
      /-maestro|-planner|-strategist|-architect|business-growth-planner|north-star-guardian|executive-reporting/,
    cat: 'Strategy & Leadership',
  },
  {
    pattern:
      /-transformer|-artisan|-composer|-renderer|-curator|word-artisan|excel-artisan|pdf-composer/,
    cat: 'Data & Content',
  },
  {
    pattern:
      /-engine|-mapper|-scorer|-predictor|-wizard|codebase-mapper|dependency-grapher|test-genie/,
    cat: 'Engineering & DevOps',
  },
  { pattern: /voice-|audio-|biometric-/, cat: 'Interface & AI' },
];

function inferCategory(name: string): string {
  for (const { pattern, cat } of CATEGORY_MAP) {
    if (pattern.test(name)) return cat;
  }
  return 'Utilities';
}

// Dynamically discover skill directories by looking into skills/ namespace
const skillsRootDir = path.join(rootDir, 'skills');
const skillDirs: string[] = [];

if (fs.existsSync(skillsRootDir)) {
  const categories = fs.readdirSync(skillsRootDir).filter(f => fs.lstatSync(path.join(skillsRootDir, f)).isDirectory());
  for (const cat of categories) {
    const catPath = path.join(skillsRootDir, cat);
    const dirs = fs.readdirSync(catPath).filter(f => {
      const p = path.join(catPath, f);
      return fs.lstatSync(p).isDirectory() && fs.existsSync(path.join(p, 'SKILL.md'));
    });
    for (const dir of dirs) {
      skillDirs.push(path.join('skills', cat, dir));
    }
  }
}

// Load Tag Dictionary
const tagDictPath = path.join(rootDir, 'knowledge/orchestration/meta-skills/tag_dictionary.json');
let tagRules: TagDictionary = { rules: [], defaults: [] };
if (fs.existsSync(tagDictPath)) {
  tagRules = JSON.parse(fs.readFileSync(tagDictPath, 'utf8'));
}

function inferTags(skillName: string, description?: string): string[] {
  const tags = new Set<string>(tagRules.defaults);
  const content = (skillName + ' ' + (description || '')).toLowerCase();

  tagRules.rules.forEach((rule) => {
    if (content.includes(rule.keyword)) {
      tags.add(rule.tag);
    }
  });
  return Array.from(tags).sort();
}

console.log(`Enriching metadata for ${skillDirs.length} skills...`);

skillDirs.forEach((relPath) => {
  const fullPath = path.join(rootDir, relPath);
  const skillMdPath = path.join(fullPath, 'SKILL.md');
  const content = safeReadFile(skillMdPath, { encoding: 'utf8' }) as string;
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
  if (!fmMatch) return;

  try {
    const fm = yaml.load(fmMatch[1]) as SkillFrontmatter;
    let modified = false;

    // 1. Category Enrichment
    const skillName = path.basename(relPath);
    if (!fm.category || fm.category === 'General') {
      fm.category = inferCategory(skillName);
      modified = true;
    }

    // 2. Tag Enrichment
    const newTags = inferTags(skillName, fm.description);
    if (JSON.stringify(fm.tags) !== JSON.stringify(newTags)) {
      fm.tags = newTags;
      modified = true;
    }

    if (modified) {
      const newFm = yaml.dump(fm, { lineWidth: -1 }).trim();
      const newContent = content.replace(/^---\n[\s\S]*?\n---/m, `---\n${newFm}\n---`);
      safeWriteFile(skillMdPath, newContent);
      console.log(
        `  [${skillName}] Metadata enriched (Category: ${fm.category}, Tags: ${fm.tags?.length || 0})`
      );
    }
  } catch (err: any) {
    console.error(`Failed to enrich ${relPath}: ${err.message}`);
  }
});

console.log('Enrichment complete.');
