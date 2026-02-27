import '@agent/core/secure-io'; // Enforce security boundaries
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { tailFile } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('log-analyst', () => {
    const logFile = process.argv[2];
    const linesToRead = parseInt(process.argv[3] || '100', 10);

    if (!logFile || !fs.existsSync(logFile)) {
      throw new Error(`Log file not found: \${logFile}`);
    }

    return tailFile(logFile, linesToRead);
  });
}
