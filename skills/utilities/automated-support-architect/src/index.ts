import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { extractFAQsFromMarkdown } from './lib.js';

const argv = createStandardYargs().option('dir', { alias: 'd', type: 'string', default: '.' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('automated-support-architect', () => {
    const targetDir = path.resolve(argv.dir as string);
    const readmePath = path.join(targetDir, 'README.md');
    let faqs: any[] = [];
    if (fs.existsSync(readmePath)) {
      faqs = extractFAQsFromMarkdown(safeReadFile(readmePath, 'utf8'));
    }
    return { directory: targetDir, faqs };
  });
}
