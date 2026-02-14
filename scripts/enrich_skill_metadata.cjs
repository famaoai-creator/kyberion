#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const rootDir = path.resolve(__dirname, '..');

const CATEGORY_MAP = [
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

function inferCategory(name) {
  for (const { pattern, cat } of CATEGORY_MAP) {
    if (pattern.test(name)) return cat;
  }
  return 'Utilities';
}

const entries = fs.readdirSync(rootDir, { withFileTypes: true });
const skillDirs = entries
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(rootDir, e.name, 'SKILL.md')))
  .map((e) => e.name);

// Load Tag Dictionary
const tagDictPath = path.join(rootDir, 'knowledge/orchestration/meta-skills/tag_dictionary.json');
let tagRules = { rules: [], defaults: [] };
if (fs.existsSync(tagDictPath)) {
  tagRules = JSON.parse(fs.readFileSync(tagDictPath, 'utf8'));
}

function inferTags(skillName, description) {
  const tags = new Set(tagRules.defaults);
  const content = (skillName + ' ' + (description || '')).toLowerCase();

  tagRules.rules.forEach((rule) => {
    if (content.includes(rule.keyword)) {
      tags.add(rule.tag);
    }
  });
  return Array.from(tags).sort();
}

console.log(`Enriching metadata for ${skillDirs.length} skills...`);

skillDirs.forEach((dir) => {
  const skillMdPath = path.join(rootDir, dir, 'SKILL.md');
  let content = fs.readFileSync(skillMdPath, 'utf8');
  // Use multi-line flag and safer matching
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
  if (!fmMatch) return;

  try {
    const fm = yaml.load(fmMatch[1]);
    let modified = false;

    // 1. Category Enrichment
    if (!fm.category || fm.category === 'General') {
      fm.category = inferCategory(dir);
      modified = true;
    }

    // 2. Tag Enrichment
    const newTags = inferTags(dir, fm.description);
    if (JSON.stringify(fm.tags) !== JSON.stringify(newTags)) {
      fm.tags = newTags;
      modified = true;
    }

    if (modified) {
      const newFm = yaml.dump(fm, { lineWidth: -1 }).trim();
      const newContent = content.replace(/^---\n[\s\S]*?\n---/m, `---\n${newFm}\n---`);
      fs.writeFileSync(skillMdPath, newContent);
      console.log(
        `  [${dir}] Metadata enriched (Category: ${fm.category}, Tags: ${fm.tags.length})`
      );
    }
  } catch (err) {
    console.error(`Failed to enrich ${dir}: ${err.message}`);
  }
});

console.log('Enrichment complete.');
