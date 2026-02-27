import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { generateTerraformAWS } from './lib.js';

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true })
  .option('out', { alias: 'o', type: 'string' })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('environment-provisioner', () => {
    const inputPath = path.resolve(argv.input as string);
    const config = JSON.parse(safeReadFile(inputPath, 'utf8'));

    const nl = String.fromCharCode(10);
    const hcl = config.services.map(generateTerraformAWS).join(nl + nl);

    if (argv.out) {
      safeWriteFile(argv.out as string, hcl);
    }
    return { status: 'success', fileCount: config.services.length };
  });
}
