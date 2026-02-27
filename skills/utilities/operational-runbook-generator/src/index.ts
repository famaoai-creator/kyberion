import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { generateRunbookMarkdown, TEMPLATES } from './lib.js';

const argv = createStandardYargs()
  .option('service', { alias: 's', type: 'string', describe: 'Service name', demandOption: true })
  .option('type', {
    alias: 't',
    type: 'string',
    choices: ['deploy', 'rollback', 'incident', 'scaling'],
    default: 'deploy',
  })
  .option('out', { alias: 'o', type: 'string' })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('operational-runbook-generator', () => {
    const service = argv.service as string;
    const type = (argv.type as string) || 'deploy';
    const template = TEMPLATES[type] || TEMPLATES.deploy;

    const markdown = generateRunbookMarkdown(service, type, template);

    if (argv.out) {
      safeWriteFile(argv.out as string, markdown);
    }

    return { service, type, markdown };
  });
}
