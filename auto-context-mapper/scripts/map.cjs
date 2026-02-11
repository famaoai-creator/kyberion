#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
 const { runSkill } = require('../../scripts/lib/skill-wrapper.cjs');
const { createStandardYargs } = require('../../scripts/lib/cli-utils.cjs');
const { walk, getAllFiles } = require('../../scripts/lib/fs-utils.cjs');
const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project root directory' })
  .option('query', { alias: 'q', type: 'string', description: 'Context query to resolve' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help().argv;

function scanKnowledgeTiers(dir) {
  const tiers = { public: [], confidential: [], personal: [] };
  const knowledgeDir = path.join(dir, 'knowledge');
  if (!fs.existsSync(knowledgeDir)) return tiers;
  function walk(d, tier, depth) {
    if (depth > 4) return;
    try {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) {
          let t = tier;
          if (e.name === 'personal') t = 'personal';
          else if (e.name === 'confidential' || e.name === 'company' || e.name === 'client') t = 'confidential';
          walk(full, t, depth + 1);
          continue;
        }
        if (['.md','.json','.yaml','.yml'].includes(path.extname(e.name))) {
          tiers[tier].push({ path: path.relative(dir, full), name: e.name, tier });
        }
      }
    } catch(_e){}
  }
  walk(knowledgeDir, 'public', 0);
  return tiers;
}

function buildContextMap(tiers, skills) {
  const links = [];
  const allFiles = [...tiers.public, ...tiers.confidential, ...tiers.personal];
  for (const file of allFiles) {
    try {
      const content = fs.readFileSync(path.join(process.cwd(), file.path), 'utf8').toLowerCase();
      for (const skill of skills) {
        if (content.includes(skill.toLowerCase())) {
          links.push({ source: file.path, target: skill, tier: file.tier, type: 'references' });
        }
      }
    } catch(_e){}
  }
  return links;
}

function resolveQuery(query, tiers, _links) {
  if (!query) return null;
  const lower = query.toLowerCase();
  const relevant = [];
  const allFiles = [...tiers.public, ...tiers.confidential, ...tiers.personal];
  for (const file of allFiles) {
    try {
      const content = fs.readFileSync(path.join(process.cwd(), file.path), 'utf8');
      if (content.toLowerCase().includes(lower)) {
        relevant.push({ file: file.path, tier: file.tier, relevance: (content.toLowerCase().split(lower).length - 1) });
      }
    } catch(_e){}
  }
  return relevant.sort((a, b) => b.relevance - a.relevance).slice(0, 10);
}

function getSkillNames(dir) {
  try {
    const indexPath = path.join(dir, 'global_skill_index.json');
    if (fs.existsSync(indexPath)) {
      const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      return (idx.skills || idx).map(s => s.name);
    }
  } catch(_e){}
  return [];
}

runSkill('auto-context-mapper', () => {
  const targetDir = path.resolve(argv.dir);
  if (!fs.existsSync(targetDir)) throw new Error(`Directory not found: ${targetDir}`);
  const tiers = scanKnowledgeTiers(targetDir);
  const skills = getSkillNames(targetDir);
  const links = buildContextMap(tiers, skills);
  const queryResult = resolveQuery(argv.query, tiers, links);
  const result = {
    directory: targetDir, query: argv.query || null,
    knowledgeAssets: { public: tiers.public.length, confidential: tiers.confidential.length, personal: tiers.personal.length, total: tiers.public.length + tiers.confidential.length + tiers.personal.length },
    contextLinks: links.slice(0, 50), linkCount: links.length,
    queryResults: queryResult,
  };
  if (argv.out) fs.writeFileSync(argv.out, JSON.stringify(result, null, 2));
  return result;
});
