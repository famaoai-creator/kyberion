/**
 * scripts/run_qa_job.ts
 * ADF-driven Quality Assurance Runner.
 * Executes QA tasks defined in SystemAction format.
 */

import { logger, safeWriteFile, safeExec } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const adfPath = process.argv[2];
  if (!adfPath) {
    console.error('Usage: npx tsx scripts/run_qa_job.ts <qa-job.adf.json>');
    process.exit(1);
  }

  const adf = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), adfPath), 'utf8'));
  logger.info(`🚀 Starting QA Job: ${adf.title || 'Untitled Job'}`);

  const results = [];
  const actions = adf.actions || [];

  for (const action of actions) {
    logger.info(`Executing QA Action: ${action.action}`);
    
    // Create a temporary input file for system-actuator
    const inputPath = path.resolve(process.cwd(), `temp-qa-input-${Date.now()}.json`);
    safeWriteFile(inputPath, JSON.stringify(action));

    try {
      // Run system-actuator from source using tsx for reliability during migration
      const output = safeExec('npx', ['tsx', 'libs/actuators/system-actuator/src/index.ts', '--input', inputPath]);
      const result = JSON.parse(output);
      results.push({ action: action.action, result });
      logger.success(`Action ${action.action} completed with status: ${result.status}`);
    } catch (err: any) {
      logger.error(`Action ${action.action} failed: ${err.message}`);
      results.push({ action: action.action, status: 'failed', error: err.message });
    } finally {
      if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    }
  }

  const reportPath = path.resolve(process.cwd(), 'active/shared/qa-report.json');
  safeWriteFile(reportPath, JSON.stringify({
    job_title: adf.title,
    timestamp: new Date().toISOString(),
    results
  }, null, 2));

  logger.info(`QA Job finished. Report saved to ${reportPath}`);
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
