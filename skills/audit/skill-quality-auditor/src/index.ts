import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { auditSkillQuality } from './lib.js';

const argv = createStandardYargs().option('dir', { alias: 'd', type: 'string', default: '.' }).argv;

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('skill-quality-auditor', () => {
    const rootDir = path.resolve(argv.dir as string);
    const skills = fs
      .readdirSync(rootDir)
      .filter((f) => fs.statSync(path.join(rootDir, f)).isDirectory());

    const results = skills.map((name) => ({
      skill: name,
      ...auditSkillQuality(path.join(rootDir, name)),
    }));

    return { results };
  });
}
