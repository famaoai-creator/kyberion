import { logger, safeExec, safeReadFile } from '@agent/core';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * scripts/run_integrity_check.ts
 * ADF-driven Integrity Check Runner.
 */

async function main() {
  const args = process.argv.slice(2);
  const adfPath = args[0] || 'knowledge/governance/integrity-policy.json';

  const resolvedPath = path.resolve(process.cwd(), adfPath);
  if (!fs.existsSync(resolvedPath)) {
    logger.error(`File not found: ${resolvedPath}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  
  if (data.action === 'integrity') {
    runActuator(resolvedPath);
  } else {
    logger.info(`Policy file detected, wrapping into integrity ADF...`);
    const adf = {
      action: 'integrity',
      checks: data.checks
    };
    const tempAdfPath = path.join(process.cwd(), 'temp-integrity-adf.json');
    fs.writeFileSync(tempAdfPath, JSON.stringify(adf, null, 2));
    
    try {
      runActuator(tempAdfPath);
    } finally {
      if (fs.existsSync(tempAdfPath)) fs.unlinkSync(tempAdfPath);
    }
  }
}

function runActuator(adfPath: string) {
  logger.info(`🚀 Starting Integrity Check via ADF: ${adfPath}`);
  try {
    const output = safeExec('npx', ['tsx', 'libs/actuators/system-actuator/src/index.ts', '-i', adfPath]);
    console.log(output);
  } catch (err: any) {
    logger.error(`❌ Integrity Check failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
