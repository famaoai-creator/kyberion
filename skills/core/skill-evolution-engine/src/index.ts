import * as fs from 'node:fs';
import * as path from 'node:path';
import { runSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { safeWriteFile } from '@agent/core/secure-io';
import { analyzeSkillHealth, suggestEvolutions, checkWorkLogs } from './lib.js';

const argv = createStandardYargs()
  .option('skill', {
    alias: 's',
    type: 'string',
    demandOption: true,
    description: 'Skill name to analyze for evolution',
  })
  .option('dir', { alias: 'd', type: 'string', default: '.', description: 'Project root' })
  .option('out', { alias: 'o', type: 'string', description: 'Output file path' })
  .help()
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runSkill('skill-evolution-engine', () => {
    const targetDir = path.resolve(argv.dir as string);
    const skillDir = path.join(targetDir, argv.skill as string);

    if (!fs.existsSync(skillDir)) {
      throw new Error(`Skill directory not found: ${skillDir}`);
    }

    const health = analyzeSkillHealth(skillDir);
    const suggestions = suggestEvolutions(argv.skill as string, health);
    const logs = checkWorkLogs(targetDir, argv.skill as string);

    const successRate =
      logs.length > 0
        ? Math.round((logs.filter((l) => l.status === 'success').length / logs.length) * 100)
        : null;

    const result = {
      skill: argv.skill,
      health,
      executionHistory: { runs: logs.length, successRate },
      evolutionSuggestions: suggestions,
      recommendations: suggestions
        .filter((s) => s.priority === 'high')
        .map((s) => `[${s.priority}] ${s.suggestion}`),
    };

    if (argv.out) {
      safeWriteFile(argv.out as string, JSON.stringify(result, null, 2));
    }

    return result;
  });
}
