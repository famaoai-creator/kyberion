import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rootDir = process.cwd();
const indexPath = path.join(rootDir, 'knowledge/public/orchestration/global_skill_index.json');

describe('Ecosystem Smoke Tests', () => {
  if (!fs.existsSync(indexPath)) {
    it.skip('Skill index not found - run generate-index first', () => {});
    return;
  }

  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const skills = index.s || index.skills;
  const implemented = skills.filter((s: any) => (s.s === 'impl' || s.status === 'implemented'));

  implemented.forEach((skill: any) => {
    const skillName = skill.n || skill.name;
    const skillPath = skill.path || skillName;
    const mainScript = skill.m || 'dist/index.js';
    const fullPath = path.join(rootDir, skillPath, mainScript);

    it(`should have valid syntax for ${skillName} (${mainScript})`, () => {
      if (!fs.existsSync(fullPath)) {
        throw new Error(`Main script not found: ${fullPath}`);
      }
      // node --check performs syntax check only, doesn't execute
      execSync(`node --check "${fullPath}"`, { stdio: 'pipe' });
    });
  });
});
