import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
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
        projectName = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).name || projectName;
      } catch {}
    }

    const prerequisites = detectPrerequisites(projectDir);
    const setupSteps = generateSetupSteps(projectDir);

    return {
      projectName,
      prerequisites,
      setupSteps,
      quickStart: `# Quick Start for \${projectName}

\${setupSteps.join('
')}`,
    };
  });
}
