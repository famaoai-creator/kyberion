import { safeWriteFile, safeReadFile } from '@agent/core/secure-io';
import { runAsyncSkill } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as pathResolver from '@agent/core/path-resolver';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createShadowTasks } from './lib.js';

const argv = createStandardYargs()
  .option('intent', { alias: 'i', type: 'string', demandOption: true })
  .option('personaA', { alias: 'a', type: 'string', default: 'Efficiency Optimizer' })
  .option('personaB', { alias: 'b', type: 'string', default: 'Security Reviewer' })
  .parseSync();

if (require.main === module || (typeof process !== 'undefined' && process.env.VITEST !== 'true')) {
  runAsyncSkill('shadow-dispatcher', async () => {
    const inboxDir = pathResolver.shared('queue/inbox');
    const outboxDir = pathResolver.shared('queue/outbox');
    const { idA, idB } = createShadowTasks(
      argv.intent as string,
      argv.personaA as string,
      argv.personaB as string,
      inboxDir
    );

    let resultA = null,
      resultB = null;
    while (!resultA || !resultB) {
      const resAPath = path.join(outboxDir, 'RES-' + idA + '.json');
      const resBPath = path.join(outboxDir, 'RES-' + idB + '.json');
      if (fs.existsSync(resAPath)) resultA = JSON.parse(safeReadFile(resAPath, 'utf8'));
      if (fs.existsSync(resBPath)) resultB = JSON.parse(safeReadFile(resBPath, 'utf8'));
      if (!resultA || !resultB) await new Promise((r) => setTimeout(r, 1000));
    }

    return { status: 'complete', results: [resultA, resultB] };
  });
}
