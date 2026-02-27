import * as fs from 'node:fs';
import * as path from 'node:path';

export function auditSkillQuality(skillDir: string): any {
  const checks: any[] = [];
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  const skillMdExists = fs.existsSync(skillMdPath);

  checks.push({
    name: 'skill-md-exists',
    passed: skillMdExists,
  });

  const pkgExists = fs.existsSync(path.join(skillDir, 'package.json'));
  checks.push({
    name: 'package-json-exists',
    passed: pkgExists,
  });

  return { checks, score: checks.filter((c) => c.passed).length };
}
