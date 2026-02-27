import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import { auditEthics } from './lib.js';

const argv = createStandardYargs().option('input', {
  alias: 'i',
  type: 'string',
  demandOption: true,
}).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('ai-ethics-auditor', () => {
    const inputPath = path.resolve(argv.input as string);
    const content = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
    const findings = auditEthics(content);

    const result = { source: path.basename(inputPath), findings };
    if (argv.out) safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    return result;
  });
}
