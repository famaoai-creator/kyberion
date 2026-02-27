import '@agent/core/secure-io'; // Enforce security boundaries
import path from 'path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { inspectSchemas } from './lib.js';

const argv = createStandardYargs().parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('schema-inspector', () => {
    const rootDir = path.resolve((argv.input as string) || '.');
    return inspectSchemas(rootDir);
  });
}
