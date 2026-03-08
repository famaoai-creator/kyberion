import { safeWriteFile, logger, safeUnlinkSync } from '@agent/core';
import { safeExec } from '@agent/core/secure-io';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const input = {
    action: 'materialize',
    blueprint_path: 'knowledge/governance/ecosystem-blueprint.json'
  };

  const inputPath = path.resolve(process.cwd(), `scratch/infra_setup_input_${Date.now()}.json`);
  safeWriteFile(inputPath, JSON.stringify(input, null, 2));

  try {
    logger.info('🚀 Starting Infrastructure Setup via Orchestrator-Actuator...');
    const actuatorPath = 'dist/libs/actuators/orchestrator-actuator/src/index.js';
    
    // Ensure actuator is built
    if (!fs.existsSync(actuatorPath)) {
      logger.info('Building orchestrator-actuator...');
      safeExec('npm', ['run', 'build', '--workspace=libs/actuators/orchestrator-actuator']);
    }

    const output = safeExec('node', [actuatorPath, '--input', inputPath]);
    const result = JSON.parse(output);

    if (result.status === 'success') {
      logger.success(`✨ Infrastructure materialized successfully: ${result.name}`);
    } else {
      logger.error('❌ Infrastructure setup failed.');
      process.exit(1);
    }
  } catch (err: any) {
    logger.error(`Setup failed: ${err.message}`);
    process.exit(1);
  } finally {
    if (fs.existsSync(inputPath)) {
      safeUnlinkSync(inputPath);
    }
  }
}

main();
