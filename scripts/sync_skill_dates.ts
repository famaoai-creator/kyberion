import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { safeWriteFile, safeReadFile } from '@agent/core';

const rootDir = process.cwd();

/**
 * Skill Date Synchronization Tool
 * Updates 'last_updated' in SKILL.md based on Git commit history.
 */

function getGitDate(filePath: string): string {
  try {
    const dateStr = execSync(`git log -1 --format=%cs -- "${filePath}"`, {
      encoding: 'utf8',
    }).trim();
    return dateStr || new Date().toISOString().split('T')[0];
  } catch (_) {
    return new Date().toISOString().split('T')[0];
  }
}

// Dynamically discover skills within namespaces
const skills: { name: string; path: string }[] = [];
const skillsRootDir = path.join(rootDir, 'skills');

if (fs.existsSync(skillsRootDir)) {
  const categories = fs
    .readdirSync(skillsRootDir)
    .filter((f) => fs.lstatSync(path.join(skillsRootDir, f)).isDirectory());
  
  for (const cat of categories) {
    const catPath = path.join(skillsRootDir, cat);
    const skillDirs = fs
      .readdirSync(catPath)
      .filter((f) => fs.lstatSync(path.join(catPath, f)).isDirectory());
    
    for (const dir of skillDirs) {
      skills.push({ name: dir, path: path.join('skills', cat, dir) });
    }
  }
}

console.log(`Syncing dates for ${skills.length} skills...`);

skills.forEach((skillObj) => {
  const skillMdPath = path.join(rootDir, skillObj.path, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) return;

  const gitDate = getGitDate(skillMdPath);
  const content = safeReadFile(skillMdPath, { encoding: 'utf8' }) as string;
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
  if (!fmMatch) return;

  try {
    const fm = yaml.load(fmMatch[1]) as any;
    if (fm.last_updated !== gitDate) {
      fm.last_updated = gitDate;
      const newFm = yaml.dump(fm, { lineWidth: -1 }).trim();
      const newContent = content.replace(/^---\n[\s\S]*?\n---/m, `---\n${newFm}\n---`);
      safeWriteFile(skillMdPath, newContent);
      console.log(`  [${skillObj.name}] last_updated -> ${gitDate}`);
    }
  } catch (err: any) {
    console.error(`Failed to sync date for ${skillObj.name}: ${err.message}`);
  }
});

console.log('Date synchronization complete.');
