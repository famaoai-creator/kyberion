#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const rootDir = path.resolve(__dirname, '..');

/**
 * Skill Date Synchronization Tool
 * Updates 'last_updated' in SKILL.md based on Git commit history.
 */

function getGitDate(filePath) {
  try {
    const dateStr = execSync(`git log -1 --format=%cs -- "${filePath}"`, {
      encoding: 'utf8',
    }).trim();
    return dateStr || new Date().toISOString().split('T')[0];
  } catch (_) {
    return new Date().toISOString().split('T')[0];
  }
}

const entries = fs.readdirSync(rootDir, { withFileTypes: true });
const skillDirs = entries
  .filter((e) => e.isDirectory() && fs.existsSync(path.join(rootDir, e.name, 'SKILL.md')))
  .map((e) => e.name);

console.log(`Syncing dates for ${skillDirs.length} skills...`);

skillDirs.forEach((dir) => {
  const skillMdPath = path.join(rootDir, dir, 'SKILL.md');
  const gitDate = getGitDate(skillMdPath);

  const content = fs.readFileSync(skillMdPath, 'utf8');
  // Safer regex for multiline matching
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
  if (!fmMatch) return;

  try {
    const fm = yaml.load(fmMatch[1]);
    if (fm.last_updated !== gitDate) {
      fm.last_updated = gitDate;
      const newFm = `---\n${yaml.dump(fm)}---`;
      const newContent = content.replace(/^---\n[\s\S]*?\n---/m, newFm);
      fs.writeFileSync(skillMdPath, newContent);
      console.log(`  [${dir}] last_updated -> ${gitDate}`);
    }
  } catch (err) {
    console.error(`Failed to sync date for ${dir}: ${err.message}`);
  }
});

console.log('Date synchronization complete.');
