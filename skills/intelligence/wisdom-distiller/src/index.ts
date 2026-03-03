import { runSkillAsync, safeReadFile, safeWriteFile } from '@agent/core';
import * as pathResolver from '@agent/core/path-resolver';
import path from 'node:path';
import fs from 'node:fs';
import * as yaml from 'js-yaml';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

runSkillAsync('wisdom-distiller', async () => {
  const argv = yargs(hideBin(process.argv))
    .option('mission', { alias: 'm', type: 'string', demandOption: true })
    .option('name', { alias: 'n', type: 'string', demandOption: true })
    .option('out-dir', { alias: 'o', type: 'string', default: 'pipelines' })
    .parseSync();

  const missionDir = pathResolver.missionDir(argv.mission as string);
  const taskBoardPath = path.join(missionDir, 'TASK_BOARD.md');

  if (!fs.existsSync(taskBoardPath)) {
    throw new Error(`Task Board not found: ${taskBoardPath}`);
  }

  console.log(`[Distiller] Analyzing mission: ${argv.mission}`);
  const content = safeReadFile(taskBoardPath, { encoding: 'utf8' }) as string;
  
  // Very basic extraction of skill sequences from Markdown
  const lines = content.split('\n');
  const steps: any[] = [];
  
  lines.forEach(line => {
    // Look for lines like "- [x] Step: skill-name --args..."
    const match = line.match(/- \[x\] \*\*.*?\*\*\s*\(ID: (.*?)\)/);
    if (match) {
      steps.push({
        id: match[1],
        skill: 'codebase-mapper', // Placeholder for simulation
        args: '--dir .'
      });
    }
  });

  const pipeline = {
    name: argv.name,
    description: `Distilled from mission ${argv.mission}`,
    steps: steps.length > 0 ? steps : [{ skill: 'placeholder', args: '--sample' }]
  };

  const outDir = argv['out-dir'] as string;
  const outPath = path.resolve(outDir, `${argv.name}.yml`);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  
  safeWriteFile(outPath, yaml.dump(pipeline));
  console.log(`[Distiller] New logic distilled to: ${outPath}`);

  return { pipeline_path: outPath, steps_extracted: steps.length };
});
