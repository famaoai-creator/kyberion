import { logger, safeReadFile, safeWriteFile, safeUnlinkSync } from '@agent/core';
import { safeExec } from '@agent/core/secure-io';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const adfPath = path.resolve(process.cwd(), 'knowledge/governance/reporting-config.json');
  if (!fs.existsSync(adfPath)) {
    logger.error('Reporting configuration ADF not found.');
    process.exit(1);
  }

  const adfContent = safeReadFile(adfPath, { encoding: 'utf8' }) as string;
  const config = JSON.parse(adfContent);

  const inputPath = path.resolve(process.cwd(), `scratch/reporting_input_${Date.now()}.json`);
  safeWriteFile(inputPath, JSON.stringify(config, null, 2));

  try {
    logger.info('🚀 Starting Reporting Job via Wisdom-Actuator...');
    const actuatorPath = 'libs/actuators/wisdom-actuator/src/index.ts';
    
    // Check if built actuator exists
    if (!fs.existsSync(actuatorPath)) {
      logger.info('Building wisdom-actuator...');
      // Use the root build or workspace-specific build if possible.
      // Based on workspace structure, we can use pnpm.
      safeExec('pnpm', ['run', 'build', '--filter', '@actuator/wisdom']);
    }

    const output = safeExec('npx', ['tsx', actuatorPath, '--input', inputPath]);
    const result = JSON.parse(output);

    if (result.status === 'success') {
      logger.success('✅ Reporting job completed successfully.');
      if (result.results) {
        result.results.forEach((r: any) => {
          if (r.status === 'success') {
            logger.info(`  - ${r.type}: OK`);
          } else {
            logger.error(`  - ${r.type}: FAILED (${r.error})`);
          }
        });
      }
    } else {
      logger.error(`❌ Reporting job failed: ${result.error}`);
      process.exit(1);
    }
  } catch (err: any) {
    logger.error(`Reporting job execution failed: ${err.message}`);
    process.exit(1);
  } finally {
    if (fs.existsSync(inputPath)) {
      safeUnlinkSync(inputPath);
    }
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
