import * as fs from 'node:fs';
import * as path from 'node:path';
import chalk from 'chalk';
import { safeWriteFile, safeReadFile } from '@agent/core';

const ROOT_DIR = process.cwd();
const MISSIONS_DIR = path.join(ROOT_DIR, 'active/missions');
const VAULT_DIR = path.join(ROOT_DIR, 'knowledge/evolution/latent-wisdom');

interface PersonaPatch {
  id: string;
  source_mission: string;
  timestamp: string;
  deviation_summary: string;
  delta_rules: string[];
  evidence_path: string;
}

export async function runAlignmentMirror() {
  console.log(chalk.cyan('🪞 Alignment Mirror: Distilling Divergent Successes into the Wisdom Vault...'));

  if (!fs.existsSync(VAULT_DIR)) {
    fs.mkdirSync(VAULT_DIR, { recursive: true });
  }

  const missions = fs.readdirSync(MISSIONS_DIR).filter(m => !m.startsWith('.'));
  
  for (const missionId of missions) {
    const statePath = path.join(MISSIONS_DIR, missionId, 'mission-state.json');
    if (!fs.existsSync(statePath)) continue;

    try {
      const stateContent = safeReadFile(statePath, { encoding: 'utf8' }) as string;
      const state = JSON.parse(stateContent);
      
      // Process Completed but un-distilled missions
      if (state.status === 'Completed' && !state.distilled) {
        const learningsPath = path.join(MISSIONS_DIR, missionId, 'LEARNINGS.md');
        
        if (fs.existsSync(learningsPath)) {
          console.log(chalk.yellow(`\n[EVOLUTION] Found latent wisdom in "${missionId}".`));
          
          const learnings = safeReadFile(learningsPath, { encoding: 'utf8' }) as string;
          const patchId = `patch-${missionId.toLowerCase()}-${Date.now().toString().slice(-4)}`;
          
          const patch: PersonaPatch = {
            id: patchId,
            source_mission: missionId,
            timestamp: new Date().toISOString(),
            deviation_summary: "Automated distillation of divergent success.",
            delta_rules: learnings.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2)),
            evidence_path: `active/missions/${missionId}/evidence/`
          };

          const patchPath = path.join(VAULT_DIR, `${patchId}.json`);
          safeWriteFile(patchPath, JSON.stringify(patch, null, 2));
          
          // Update mission state
          state.distilled = true;
          state.patch_id = patchId;
          safeWriteFile(statePath, JSON.stringify(state, null, 2));
          
          console.log(chalk.green(`✅ Distilled: ${patchPath}`));
        }
      }
    } catch (err: any) {
      console.error(chalk.red(`Error processing mission ${missionId}: ${err.message}`));
    }
  }

  console.log(chalk.cyan('\n✨ Vault synchronization complete.'));
}

if (require.main === module) {
  runAlignmentMirror();
}
