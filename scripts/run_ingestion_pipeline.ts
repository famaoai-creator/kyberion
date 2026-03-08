import { logger, safeExec, safeReadFile, safeWriteFile } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * scripts/run_ingestion_pipeline.ts
 * ADF-driven Ingestion Pipeline Runner.
 */

async function main() {
  const args = process.argv.slice(2);
  const adfPath = args[0];

  if (!adfPath) {
    console.error('Usage: npx tsx scripts/run_ingestion_pipeline.ts <adf-path>');
    process.exit(1);
  }

  const resolvedAdfPath = path.resolve(process.cwd(), adfPath);
  if (!fs.existsSync(resolvedAdfPath)) {
    logger.error(`ADF not found: ${resolvedAdfPath}`);
    process.exit(1);
  }

  logger.info(`🚀 Starting Ingestion Pipeline via ADF: ${adfPath}`);

  try {
    // Run the network-actuator with the provided ADF
    // Note: network-actuator is implemented in TypeScript and compiled to JS
    // We can run it via npx ts-node or just node if it's already built.
    // Given the environment, npx tsx is safer for direct execution.
    const output = safeExec('npx', ['tsx', 'libs/actuators/network-actuator/src/index.ts', '-i', adfPath]);
    
    console.log(output);
    logger.success('✅ Ingestion Pipeline completed successfully.');
  } catch (err: any) {
    logger.error(`❌ Ingestion Pipeline failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
