import { runSkill } from '@agent/core';
import { requireArgs } from '@agent/core/validators';
import * as pathResolver from '@agent/core/path-resolver';
import { createSkillStructure } from './lib.js';

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('autonomous-skill-designer', () => {
    const args = requireArgs(['name', 'description']);
    const rootDir = pathResolver.rootDir();

    const path = createSkillStructure(args.name as string, args.description as string, rootDir);

    return { status: 'created', path };
  });
}
