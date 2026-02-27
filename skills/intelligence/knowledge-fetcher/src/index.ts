import * as path from 'node:path';
import * as fs from 'node:fs';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { searchKnowledge } from './lib.js';

const argv = createStandardYargs()
  .option('query', { alias: 'q', type: 'string', demandOption: true })
  .option('type', { alias: 't', type: 'string', default: 'all' })
  .parseSync();

const KNOWLEDGE_BASE = path.join(process.cwd(), 'knowledge');

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('knowledge-fetcher', () => {
    const targetDir =
      argv.type === 'all' ? KNOWLEDGE_BASE : path.join(KNOWLEDGE_BASE, argv.type as string);

    if (!fs.existsSync(targetDir)) {
      throw new Error(`Knowledge directory not found: ${targetDir}`);
    }

    const hits = searchKnowledge(targetDir, argv.query as string);
    return {
      query: argv.query,
      type: argv.type,
      totalHits: hits.length,
      results: hits,
    };
  });
}
