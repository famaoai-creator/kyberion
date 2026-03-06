import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, sre, pathResolver, safeWriteFile } from '@agent/core';

/**
 * scripts/auto_repair.ts
 * Analyzes failure logs and generates an Actionable Repair Plan.
 */

async function main() {
  const args = process.argv.slice(2);
  const logPath = args[0];
  const missionId = process.env.MISSION_ID;

  if (!logPath) {
    console.log('Usage: MISSION_ID=M-XXX npx tsx scripts/auto_repair.ts <log_file_path>');
    process.exit(1);
  }

  if (!fs.existsSync(logPath)) {
    logger.error(`Log file not found: ${logPath}`);
    process.exit(1);
  }

  const logs = fs.readFileSync(logPath, 'utf8');
  const analysis = sre.analyzeRootCause(logs);

  if (!analysis) {
    logger.warn('No matching error signature found. AI will need to investigate manually.');
    process.exit(0);
  }

  logger.info(`🔍 Failure Analysis: ${analysis.cause}`);
  logger.info(`💡 Recommendation: ${analysis.recommendation}`);

  const repairPlan = {
    ts: new Date().toISOString(),
    cause: analysis.cause,
    recommendation: analysis.recommendation,
    suggested_action: analysis.action,
    context_injection: `FIX_HINT: The last command failed due to ${analysis.cause}. ${analysis.recommendation} Try running: ${analysis.action || 'investigate'}`
  };

  // If a mission is active, update its TASK_BOARD.md with the repair hint
  if (missionId) {
    const missionDir = pathResolver.missionDir(missionId);
    const taskBoardPath = path.join(missionDir, 'TASK_BOARD.md');
    
    if (fs.existsSync(taskBoardPath)) {
      let content = fs.readFileSync(taskBoardPath, 'utf8');
      const hintHeader = `\n### 🚨 Dynamic Repair Hint (${analysis.cause})\n- **Observation**: ${analysis.impact}\n- **Next Action**: [ ] ${analysis.recommendation} (Use \`${analysis.action || 'investigate'}\`)\n`;
      
      if (!content.includes(analysis.cause)) {
        content += hintHeader;
        safeWriteFile(taskBoardPath, content);
        logger.success(`🛠️ Repair Hint injected into TASK_BOARD.md for mission ${missionId}`);
      }
    }
  }

  // Also write a standalone evidence file
  const evidencePath = logPath.replace('.log', '.repair.json');
  safeWriteFile(evidencePath, JSON.stringify(repairPlan, null, 2));
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
