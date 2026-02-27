import '@agent/core/secure-io'; // Enforce security boundaries
import * as path from 'node:path';
import { runAsyncSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as pathResolver from '@agent/core/path-resolver';
import { routeDocumentGeneration } from './lib.js';

const argv = createStandardYargs()
  .option('format', {
    alias: 'f',
    type: 'string',
    choices: ['pdf', 'docx', 'xlsx', 'pptx', 'html'],
    demandOption: true,
  })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('document-generator', async () => {
    const input = path.resolve(argv.input as string);
    const output = path.resolve(argv.out as string);
    const format = (argv.format as string).toLowerCase();
    const rootDir = pathResolver.rootDir();

    const result = routeDocumentGeneration(format, input, output, rootDir);

    try {
      return JSON.parse(result).data;
    } catch {
      return { message: `Document generated at \${argv.out}`, raw: result };
    }
  });
}
