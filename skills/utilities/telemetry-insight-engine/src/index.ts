import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { analyzeTelemetry } from './lib.js';

const argv = createStandardYargs()
  .option('input', { alias: 'i', type: 'string', demandOption: true })
  .option('out', { alias: 'o', type: 'string' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('telemetry-insight-engine', () => {
    const inputPath = path.resolve(argv.input as string);
    const data = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const events = Array.isArray(data.events) ? data.events : Array.isArray(data) ? data : [];

    const stats = analyzeTelemetry(events);
    const result = { source: path.basename(inputPath), stats };

    if (argv.out) safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    return result;
  });
}
