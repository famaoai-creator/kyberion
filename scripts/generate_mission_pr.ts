/**
 * scripts/generate_mission_pr.ts
 * Automatically generates a high-fidelity GitHub PR description from mission state.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '@agent/core';

const ROOT_DIR = process.cwd();
const MISSIONS_DIR = path.join(ROOT_DIR, 'active/missions');

async function generatePR(missionId: string) {
  const missionDir = path.join(MISSIONS_DIR, missionId);
  const statePath = path.join(missionDir, 'mission-state.json');
  const boardPath = path.join(missionDir, 'TASK_BOARD.md');

  if (!fs.existsSync(statePath)) {
    logger.error(`Mission state for ${missionId} not found.`);
    return;
  }

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const board = fs.existsSync(boardPath) ? fs.readFileSync(boardPath, 'utf8') : '';

  let prBody = `# Mission PR: ${state.mission_id}\n\n`;
  prBody += `## 🎯 Overview\nThis PR completes the mission **${state.mission_id}**. \n`;
  prBody += `**Persona**: ${state.assigned_persona} | **Priority**: ${state.priority}\n\n`;

  prBody += `## 🏆 Achieved Milestones\n`;
  state.milestones.forEach((m: any) => {
    const icon = m.status === 'completed' ? '✅' : '⏳';
    prBody += `- ${icon} **${m.title}** (${m.status})\n`;
  });
  prBody += `\n`;

  if (state.git && state.git.checkpoints) {
    prBody += `## 🛡️ Physical Evidence (Checkpoints)\n`;
    state.git.checkpoints.forEach((cp: any) => {
      prBody += `- \`${cp.commit_hash.substring(0, 8)}\`: ${cp.task_id} (${new Date(cp.ts).toLocaleString()})\n`;
    });
    prBody += `\n`;
  }

  prBody += `## 📋 Task Board Summary\n\`\`\`markdown\n${board.substring(0, 500)}...\n\`\`\`\n\n`;

  prBody += `## 🚀 Next Steps\n${state.context?.next_step || 'Continue ecosystem expansion.'}\n\n`;
  
  prBody += `---\n*Generated autonomously by Gemini Ecosystem Governance.*`;

  const outputPath = path.join(missionDir, 'PR_DESCRIPTION.md');
  fs.writeFileSync(outputPath, prBody);
  console.log(prBody);
  logger.success(`✅ PR Description generated at ${outputPath}`);
}

const mid = process.argv[2];
if (!mid) {
  console.log('Usage: npx tsx scripts/generate_mission_pr.ts <MISSION_ID>');
} else {
  generatePR(mid).catch(e => logger.error(e.message));
}
