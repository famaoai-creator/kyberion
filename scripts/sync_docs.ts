import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeWriteFile, safeReadFile } from '@agent/core';

const rootDir = process.cwd();
const indexPath = path.join(rootDir, 'knowledge/orchestration/global_skill_index.json');
const readmePath = path.join(rootDir, 'README.md');
const guidePath = path.join(rootDir, 'SKILLS_GUIDE.md');

interface SkillEntry {
  n: string;
  s: 'impl' | 'plan';
  [key: string]: any;
}

interface SkillIndex {
  t: number;
  s: SkillEntry[];
}

function sync(): void {
  if (!fs.existsSync(indexPath)) {
    console.error('Index not found. Run npm run generate-index first.');
    process.exit(1);
  }

  const indexRaw = safeReadFile(indexPath, { encoding: 'utf8' }) as string;
  const index: SkillIndex = JSON.parse(indexRaw);
  const total = index.t;
  const skills = index.s;
  
  const implemented = skills.filter((s) => s.s === 'impl').length;
  const planned = skills.filter((s) => s.s === 'plan').length;

  console.log(`Syncing docs: ${total} total, ${implemented} implemented, ${planned} planned...`);

  // 1. Update README.md
  if (fs.existsSync(readmePath)) {
    let readme = safeReadFile(readmePath, { encoding: 'utf8' }) as string;
    readme = readme.replace(
      /\*\*(\d+) skills\*\* \(all implemented\)/,
      `**${implemented} skills** (all implemented)`
    );
    readme = readme.replace(/Implemented Skills \((\d+)\)/, `Implemented Skills (${implemented})`);
    safeWriteFile(readmePath, readme);
  }

  // 2. Update SKILLS_GUIDE.md
  if (fs.existsSync(guidePath)) {
    let guide = safeReadFile(guidePath, { encoding: 'utf8' }) as string;
    guide = guide.replace(/Total Skills: (\d+)/, `Total Skills: ${implemented}`);
    guide = guide.replace(
      /Last updated: \d{4}\/\d{1,2}\/\d{1,2}/,
      `Last updated: ${new Date().toISOString().split('T')[0].replace(/-/g, '/')}`
    );
    safeWriteFile(guidePath, guide);
  }

  console.log('[SUCCESS] README.md and SKILLS_GUIDE.md synchronized.');
}

sync();
