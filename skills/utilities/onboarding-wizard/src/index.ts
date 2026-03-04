import { runSkill, safeReadFile, safeWriteFile } from '@agent/core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import { detectPrerequisites, generateSetupSteps } from './lib.js';

const argv = createStandardYargs()
  .option('dir', {
    alias: 'd',
    type: 'string',
    default: '.',
    description: 'Project directory',
  })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('onboarding-wizard', () => {
    const projectDir = path.resolve(argv.dir as string);
    if (!fs.existsSync(projectDir)) {
      throw new Error(`Directory does not exist: \${projectDir}`);
    }

    const pkgPath = path.join(projectDir, 'package.json');
    let projectName = path.basename(projectDir);
    if (fs.existsSync(pkgPath)) {
      try {
        projectName = JSON.parse(safeReadFile(pkgPath, { encoding: 'utf8' }) as string).name || projectName;
      } catch {}
    }

    const prerequisites = detectPrerequisites();
    const setupSteps = generateSetupSteps();

    return {
      projectName,
      prerequisites,
      setupSteps,
      quickStart: `# Quick Start for \${projectName}

\${setupSteps.join('\n')}`,
    };
  });
}
