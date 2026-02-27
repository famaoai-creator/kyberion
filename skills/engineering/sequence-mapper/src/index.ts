import * as fs from 'fs';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { generateSequenceDiagram } from './lib.js';

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true })
  .option('out', { alias: 'o', type: 'string' }).argv;

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('sequence-mapper', () => {
    const inputPath = argv.input as string;
    const content = fs.readFileSync(inputPath, 'utf8');
    const mermaid = generateSequenceDiagram(content);

    if (argv.out) {
      safeWriteFile(argv.out as string, mermaid);
      return { output: argv.out, size: mermaid.length };
    } else {
      return { content: mermaid };
    }
  });
}
