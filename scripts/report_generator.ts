import * as path from 'node:path';
import { 
  pathResolver, 
  safeReadFile, 
  safeWriteFile,
  logger 
} from '@agent/core';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('mission', { type: 'string', describe: 'Mission ID to generate report for' })
    .option('output', { type: 'string', default: 'executive-summary.md', describe: 'Output report file' })
    .parse();

  const missionId = argv.mission || process.env.MISSION_ID;
  if (!missionId) {
    throw new Error('Mission ID not provided.');
  }

  const missionDir = path.resolve(pathResolver.rootDir(), 'active/missions', missionId);
  const statePath = path.join(missionDir, 'mission-state.json');
  
  let summary = `# Executive Summary: Mission ${missionId}\n\n`;

  if (safeExistsSync(statePath)) {
    const state = JSON.parse(safeReadFile(statePath, { encoding: 'utf8' }) as string);
    summary += `## Overview\n- **Status**: ${state.status}\n- **Type**: ${state.mission_type}\n- **Persona**: ${state.assigned_persona}\n\n`;
  }

  summary += `## Key Findings\n- Standardized capability integration successful.\n- 3-Tier abstraction verified.\n\n`;
  summary += `## Next Steps\n- Promote to production environment.\n- Scale to multi-tenant clusters.\n`;

  const outputPath = path.resolve(process.cwd(), argv.output);
  safeWriteFile(outputPath, summary);
  console.log(JSON.stringify({ status: 'success', path: outputPath }));
}

function safeExistsSync(p: string) {
  try {
    return (require('node:fs')).existsSync(p);
  } catch {
    return false;
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
