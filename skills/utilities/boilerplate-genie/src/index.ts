import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill, safeWriteFile } from '@agent/core';
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

    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    let fileRecord: Record<string, string>;
    switch (projectType) {
      case 'node':
        fileRecord = generateNodeProject(projectName);
        break;
      case 'python':
        fileRecord = generatePythonProject(projectName);
        break;
      case 'generic':
        fileRecord = generateGenericProject(projectName);
        break;
      default:
        throw new Error(`Unsupported type: ${projectType}`);
    }

    const filesGenerated: string[] = [];
    for (const [filename, content] of Object.entries(fileRecord)) {
      const fullPath = path.join(outDir, filename);
      const parentDir = path.dirname(fullPath);
      if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
      safeWriteFile(fullPath, content);
      filesGenerated.push(filename);
    }

    return { name: projectName, type: projectType, files: filesGenerated, directory: outDir };
  });
}
