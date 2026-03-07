/**
 * scripts/audit_skills.ts
 * Audits all skills for completeness and assigns a quality score.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, safeReadFile, safeWriteFile } from '@agent/core';

const ROOT_DIR = process.cwd();
const SKILLS_DIR = path.join(ROOT_DIR, 'skills');
const INDEX_FILE = path.join(ROOT_DIR, 'knowledge/orchestration/global_skill_index.json');

async function audit() {
  logger.info('📊 Auditing Skill Quality...');
  if (!fs.existsSync(INDEX_FILE)) return;

  const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  const skills = index.s || [];

  for (const skill of skills) {
    const fullPath = path.join(ROOT_DIR, skill.path);
    let score = 0;

    // 1. Physical presence (40 pts)
    if (fs.existsSync(path.join(fullPath, 'SKILL.md'))) score += 15;
    if (fs.existsSync(path.join(fullPath, 'package.json'))) score += 15;
    if (fs.existsSync(path.join(fullPath, 'src/index.ts'))) score += 10;

    // 2. Metadata Completeness (40 pts)
    const skillMd = fs.existsSync(path.join(fullPath, 'SKILL.md')) 
      ? fs.readFileSync(path.join(fullPath, 'SKILL.md'), 'utf8') : '';
    
    if (skillMd.includes('description:')) score += 10;
    if (skillMd.includes('status: implemented')) score += 10;
    if (skillMd.includes('## 🛠️ Usage')) score += 10;
    if (skillMd.includes('## 📋 Role')) score += 10;

    // 3. Risk and Tags (20 pts)
    if (skill.r !== 'unknown') score += 10;
    if (skill.t && skill.t.length > 0) score += 10;

    skill.q = score; // Quality score field
  }

  index.u = new Date().toISOString();
  safeWriteFile(INDEX_FILE, JSON.stringify(index, null, 2));
  logger.success(`✅ Audited ${skills.length} skills. Scores updated in index.`);
}

audit().catch(e => logger.error(e.message));
