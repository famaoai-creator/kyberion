import { runSkillAsync, logger, safeReadFile, safeWriteFile } from '@agent/core';
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
  const evidenceDir = path.join(missionDir, 'evidence');

  console.log(`[Distiller] Distilling knowledge from mission: ${argv.mission}`);

  const steps: any[] = [];

  // Data-Driven Extraction: Read JSON artifacts from evidence directory
  if (fs.existsSync(evidenceDir)) {
    const files = fs.readdirSync(evidenceDir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
    
    // Sort files by filename to preserve sequence
    files.sort().forEach(file => {
      const filePath = path.join(evidenceDir, file);
      try {
        const artifact = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (artifact.status === 'success') {
          steps.push({
            id: artifact.id,
            skill: artifact.skill,
            args: artifact.args
          });
        }
      } catch (err) {
        console.error(`[Distiller] Failed to parse artifact ${file}:`, err);
      }
    });
  }

  // Fallback to TASK_BOARD.md if no JSON artifacts found (for legacy support)
  if (steps.length === 0) {
    const taskBoardPath = path.join(missionDir, 'TASK_BOARD.md');
    if (fs.existsSync(taskBoardPath)) {
      console.log(`[Distiller] No JSON artifacts found. Falling back to TASK_BOARD.md`);
      const content = safeReadFile(taskBoardPath, { encoding: 'utf8' }) as string;
      const lines = content.split('\n');
      lines.forEach(line => {
        const match = line.match(/- \[x\] \*\*.*?\*\*\s*\(ID: (.*?)\)/);
        if (match) {
          steps.push({
            id: match[1],
            skill: 'unknown-skill',
            args: '--check-task-board'
          });
        }
      });
    }
  }

  if (steps.length === 0) {
    throw new Error(`No successful tasks found to distill in mission ${argv.mission}`);
  }

  const pipeline = {
    name: argv.name,
    description: `Distilled from mission ${argv.mission}`,
    steps: steps.map(s => ({
      id: String(s.id),
      skill: String(s.skill),
      args: String(s.args)
    }))
  };

  const outDir = argv['out-dir'] as string;
  const outPath = path.resolve(outDir, `${argv.name}.yml`);
  
  // High-fidelity MANUAL YAML Generation (Bypass unstable js-yaml)
  let yamlContent = `name: ${argv.name}\ndescription: Distilled from mission ${argv.mission}\nsteps:\n`;
  for (const s of steps) {
    yamlContent += `  - id: ${s.id}\n    skill: ${s.skill}\n    args: ${s.args}\n`;
  }
  
  safeWriteFile(outPath, yamlContent);
  
  // High-fidelity JSON Backup (to verify data integrity)
  const jsonPath = outPath.replace(/\.yml$/, '.json');
  safeWriteFile(jsonPath, JSON.stringify(pipeline, null, 2));
  
  console.log(`[Distiller] SUCCESS: High-fidelity logic crystallized to: ${outPath}`);
  console.log(`[Distiller] JSON backup created at: ${jsonPath}`);

  return { pipeline_path: outPath, steps_distilled: steps.length, mode: 'data-driven' };
});
