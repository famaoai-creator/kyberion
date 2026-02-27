import * as path from 'node:path';
import * as fs from 'node:fs';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { scanKnowledgeTiers, buildContextMap } from './lib.js';

const argv = createStandardYargs()
  .option('dir', { alias: 'd', type: 'string', default: '.' })
  .option('out', { alias: 'o', type: 'string' }).parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('auto-context-mapper', () => {
    const targetDir = path.resolve(argv.dir as string);
    const tiers = scanKnowledgeTiers(targetDir);

    // Get skill names from index
    let skills: string[] = [];
    const indexPath = path.join(targetDir, 'knowledge/orchestration/global_skill_index.json');
    if (fs.existsSync(indexPath)) {
      const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      skills = (idx.skills || idx).map((s: any) => s.name || s.n);
    }

    const links = buildContextMap(tiers, skills, targetDir);

    const result = {
      directory: targetDir,
      knowledgeAssets: {
        public: tiers.public.length,
        confidential: tiers.confidential.length,
        personal: tiers.personal.length,
        total: tiers.public.length + tiers.confidential.length + tiers.personal.length,
      },
      contextLinks: links.slice(0, 50),
      linkCount: links.length,
    };

    if (argv.out) safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    return result;
  });
}
