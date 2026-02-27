import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { requireArgs } from '@agent/core/validators';
import {
  generateNodeProject,
  generatePythonProject,
  generateGenericProject,
  ProjectType,
} from './lib.js';

const argv = createStandardYargs()
  .option('name', { alias: 'n', type: 'string', demandOption: true })
  .option('type', {
    alias: 'T',
    type: 'string',
    choices: ['node', 'python', 'generic'],
    demandOption: true,
  })
  .option('out', { alias: 'o', type: 'string' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('boilerplate-genie', () => {
    requireArgs(argv as any, ['name', 'type']);
    const projectName = argv.name as string;
    const projectType = argv.type as ProjectType;
    const outDir = path.resolve((argv.out as string) || projectName);

    fs.mkdirSync(outDir, { recursive: true });

    let files: string[];
    switch (projectType) {
      case 'node':
        files = generateNodeProject(projectName, outDir);
        break;
      case 'python':
        files = generatePythonProject(projectName, outDir);
        break;
      case 'generic':
        files = generateGenericProject(projectName, outDir);
        break;
      default:
        throw new Error(`Unsupported type: ${projectType}`);
    }

    return { name: projectName, type: projectType, files, directory: outDir };
  });
}
