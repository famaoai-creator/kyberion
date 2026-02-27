import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { extractEndpoints, detectBreakingChanges } from './lib.js';

const argv = createStandardYargs()
  .option('current', {
    alias: 'c',
    type: 'string',
    demandOption: true,
    description: 'Path to current OpenAPI spec'
  })
  .option('previous', {
    alias: 'p',
    type: 'string',
    description: 'Path to previous OpenAPI spec for compatibility check'
  })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('api-evolution-manager', () => {
    const currentPath = path.resolve(argv.current as string);
    const currentSpec = JSON.parse(safeReadFile(currentPath, { encoding: 'utf8' }) as string);
    const endpoints = extractEndpoints(currentSpec);
    
    const result: any = { 
      status: 'analyzed',
      endpointCount: endpoints.length, 
      endpoints 
    };

    if (argv.previous) {
      const prevPath = path.resolve(argv.previous as string);
      const prevSpec = JSON.parse(safeReadFile(prevPath, { encoding: 'utf8' }) as string);
      result.breakingChanges = detectBreakingChanges(prevSpec, currentSpec);
      result.compatible = result.breakingChanges.length === 0;
    }

    if (argv.out) {
      safeWriteFile(path.resolve(argv.out as string), JSON.stringify(result, null, 2));
    }

    return result;
  });
}
