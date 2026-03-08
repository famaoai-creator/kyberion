import { logger, safeWriteFile, safeExec } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * scripts/run_adf_validate.ts
 * ADF-driven Skill Validation Runner.
 */

async function main() {
  const adfPath = path.join(process.cwd(), 'scratch/validate_action.json');
  const adfContent = {
    action: 'validate',
    rules_path: 'knowledge/governance/skill-validation.json',
    target_dir: 'skills'
  };

  if (!fs.existsSync(path.dirname(adfPath))) {
    fs.mkdirSync(path.dirname(adfPath), { recursive: true });
  }

  safeWriteFile(adfPath, JSON.stringify(adfContent, null, 2));

  logger.info('🚀 Running ADF-driven skill validation...');
  try {
    // Calling the system-actuator with the generated ADF
    const result = safeExec('npx', ['tsx', 'libs/actuators/system-actuator/src/index.ts', '--input', adfPath]);
    const parsed = JSON.parse(result);
    
    if (parsed.status === 'failed') {
      logger.error(`❌ Validation failed with ${parsed.errors} errors.`);
      process.exit(1);
    } else {
      logger.success(`✅ Validation successful: ${parsed.checked} skills checked.`);
    }
  } catch (err: any) {
    logger.error(`Validation runner failed: ${err.message}`);
    process.exit(1);
  }
}

main();
