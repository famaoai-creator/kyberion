import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import { safeWriteFile, secretGuard, logger } from '@agent/core';

/**
 * scripts/harvest_all_incidents.ts
 * [SECURE-IO & SECRET-GUARD COMPLIANT]
 */

const API_KEY = secretGuard.getSecret('GEMINI_INCIDENT_API_KEY');
const SPACE_URL = process.env.GEMINI_INCIDENT_SPACE_URL;
const PROJECT_ID = process.env.GEMINI_INCIDENT_PROJECT_ID; // NBS_INCIDENT

async function fetchAllIssues(): Promise<void> {
  if (!API_KEY) {
    logger.error('ERROR: GEMINI_INCIDENT_API_KEY secret is not set.');
    process.exit(1);
  }

  if (!SPACE_URL || !PROJECT_ID) {
    logger.error('ERROR: GEMINI_INCIDENT_SPACE_URL or PROJECT_ID environment variable is missing.');
    process.exit(1);
  }

  const allIssues: any[] = [];
  let offset = 0;
  const count = 100;

  logger.info('Starting full data collection from Backlog...');

  while (true) {
    const url = `${SPACE_URL}/api/v2/issues?apiKey=${API_KEY}&projectId[]=${PROJECT_ID}&count=${count}&offset=${offset}&sort=created&order=desc`;
    try {
      // Use curl via execSync for simple direct API call without extra dependencies
      // Note: apiKey is in URL, which is not ideal but compliant with current script logic.
      // Future improvement: move to headers if possible.
      const response = execSync(`curl -s "${url}"`, { encoding: 'utf8' });
      const issues = JSON.parse(response);

      if (!Array.isArray(issues) || issues.length === 0) break;

      allIssues.push(...issues);
      logger.info(`Fetched ${allIssues.length} issues...`);

      if (issues.length < count) break;
      offset += count;
    } catch (e: any) {
      logger.error(`Fetch failed: ${e.message}`);
      break;
    }
  }

  const outPath = 'active/shared/nbs_incidents_all.json';
  safeWriteFile(outPath, JSON.stringify(allIssues, null, 2));
  logger.success(`Total ${allIssues.length} issues saved to ${outPath}`);
}

fetchAllIssues().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
