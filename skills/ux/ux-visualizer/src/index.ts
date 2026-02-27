import * as fs from 'node:fs';
import * as path from 'node:path';
import { runAsyncSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { generateMermaidUX } from './lib.js';

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true })
  .option('fidelity', { alias: 'f', type: 'string', choices: ['low', 'high'], default: 'high' })
  .option('output', { alias: 'o', type: 'string' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('ux-visualizer', async () => {
    const title = path.basename(argv.input as string);
    const mermaid = generateMermaidUX(title, argv.fidelity as string);

    const outPath = (argv.output as string) || path.join(process.cwd(), 'ux_output.mmd');
    fs.writeFileSync(outPath, mermaid);

    return { fidelity: argv.fidelity, output: outPath };
  });
}
