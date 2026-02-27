import '@agent/core/secure-io'; // Enforce security boundaries
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGitStatus } from './lib.js';

const argv = createStandardYargs().option('dir', { alias: 'd', type: 'string', default: '.' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('github-skills-manager', () => {
    const targetDir = path.resolve(argv.dir as string);
    const items = fs.readdirSync(targetDir);
    const results: any[] = [];

    items.forEach((item) => {
      const fullPath = path.join(targetDir, item);
      if (fs.statSync(fullPath).isDirectory()) {
        const status = getGitStatus(fullPath);
        if (status) {
          results.push({ name: item, ...status });
        }
      }
    });

    return { directory: targetDir, repositories: results };
  });
}
