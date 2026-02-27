import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { extractEndpoints } from './lib.js';

const argv = createStandardYargs().option('current', {
  alias: 'c',
  type: 'string',
  demandOption: true,
}).argv;

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('api-evolution-manager', () => {
    const content = fs.readFileSync(path.resolve(argv.current as string), 'utf8');
    const spec = JSON.parse(content);
    const endpoints = extractEndpoints(spec);
    return { endpointCount: endpoints.length, endpoints };
  });
}
