import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger, safeWriteFile, pathResolver } from '@agent/core';
import { execSync } from 'node:child_process';

/**
 * scripts/ingest_issue.ts
 * Simulates Symphony's issue polling by creating a mission from an external reference.
 */

async function main() {
  const args = process.argv.slice(2);
  const issueUrl = args[0]; // e.g., https://github.com/org/repo/issues/123
  const tenantId = args[1] || 'default';

  if (!issueUrl) {
    console.log('Usage: npx tsx scripts/ingest_issue.ts <issue_url> [tenant_id]');
    process.exit(1);
  }

  // Derive mission ID from issue URL
  const issueId = issueUrl.split('/').pop()?.replace(/[^a-zA-Z0-9]/g, '') || 'NEW';
  const missionId = `MSN-ISSUE-${issueId}`;

  logger.info(`📥 Ingesting Issue: ${issueUrl}`);

  // Invoke create_mission.ts logic via CLI or direct call
  const cmd = `npx tsx scripts/create_mission.ts ${missionId} ${tenantId} development`;
  try {
    execSync(cmd, { stdio: 'inherit' });
    
    // Update state with external_ref
    const missionDir = pathResolver.missionDir(missionId);
    const statePath = path.join(missionDir, 'mission-state.json');
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state.external_ref = issueUrl;
      safeWriteFile(statePath, JSON.stringify(state, null, 2));
      logger.success(`✅ Mission ${missionId} linked to issue: ${issueUrl}`);
    }
  } catch (err: any) {
    logger.error(`Ingestion failed: ${err.message}`);
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
