/**
 * scripts/run_wisdom_distill.ts
 * ADF-driven runner for Wisdom Distillation.
 */

import { logger, safeReadFile, safeWriteFile, pathResolver, safeExec } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const adfPath = process.argv[2] || 'work/wisdom-job.json';
  const fullAdfPath = path.isAbsolute(adfPath) ? adfPath : path.resolve(process.cwd(), adfPath);

  if (!fs.existsSync(fullAdfPath)) {
    // Create a default job if not exists
    const defaultJob = {
      version: "1.0.0",
      job_id: `distill-${Date.now()}`,
      timestamp: new Date().toISOString(),
      mode: "all",
      options: {
        include_logs: true,
        target_tier: "confidential"
      }
    };
    if (!fs.existsSync(path.dirname(fullAdfPath))) fs.mkdirSync(path.dirname(fullAdfPath), { recursive: true });
    safeWriteFile(fullAdfPath, JSON.stringify(defaultJob, null, 2));
    logger.info(`Created default ADF job at ${fullAdfPath}`);
  }

  logger.info(`🚀 Starting Wisdom Distillation Job: ${fullAdfPath}`);

  // Invoke wisdom-actuator
  try {
    const output = safeExec('npx', ['tsx', 'libs/actuators/wisdom-actuator/src/index.ts', '--input', fullAdfPath]);
    console.log(output);
    logger.success('✅ Wisdom Distillation Job completed.');
  } catch (err: any) {
    logger.error(`Job execution failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
