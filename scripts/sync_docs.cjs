#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');
const readmePath = path.join(rootDir, 'README.md');
const guidePath = path.join(rootDir, 'SKILLS_GUIDE.md');

if (!fs.existsSync(indexPath)) {
  console.error('Index not found. Run npm run generate-index first.');
  process.exit(1);
}

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const total = index.total_skills;
const implemented = index.skills.filter((s) => s.status === 'implemented').length;
const planned = index.skills.filter((s) => s.status === 'planned').length;

console.log(`Syncing docs: ${total} total, ${implemented} implemented, ${planned} planned...`);

// 1. Update README.md
if (fs.existsSync(readmePath)) {
  let readme = fs.readFileSync(readmePath, 'utf8');
  readme = readme.replace(
    /\*\*(\d+) skills\*\* \(all implemented\)/,
    `**${implemented} skills** (all implemented)`
  );
  readme = readme.replace(/Implemented Skills \((\d+)\)/, `Implemented Skills (${implemented})`);
  fs.writeFileSync(readmePath, readme);
}

// 2. Update SKILLS_GUIDE.md
if (fs.existsSync(guidePath)) {
  let guide = fs.readFileSync(guidePath, 'utf8');
  guide = guide.replace(/Total Skills: (\d+)/, `Total Skills: ${implemented}`);
  guide = guide.replace(
    /Last updated: \d{4}\/\d{1,2}\/\d{1,2}/,
    `Last updated: ${new Date().toISOString().split('T')[0].replace(/-/g, '/')}`
  );
  fs.writeFileSync(guidePath, guide);
}

console.log('[SUCCESS] README.md and SKILLS_GUIDE.md synchronized.');
