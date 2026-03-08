import { safeWriteFile, logger, safeUnlinkSync } from '@agent/core';
import { safeExec } from '@agent/core/secure-io';
import * as path from 'node:path';
import * as fs from 'node:fs';

async function main() {
  const input = {
    action: 'audit',
    rules_path: 'knowledge/governance/standard-policy.json'
  };

  const inputPath = path.resolve(process.cwd(), `scratch/governance_audit_input_${Date.now()}.json`);
  safeWriteFile(inputPath, JSON.stringify(input, null, 2));

  try {
    logger.info('🚀 Starting Governance Audit via System-Actuator...');
    const actuatorPath = 'dist/libs/actuators/system-actuator/src/index.js';
    
    // Ensure actuator is built
    if (!fs.existsSync(actuatorPath)) {
      logger.info('Building system-actuator...');
      safeExec('npm', ['run', 'build', '--workspace=libs/actuators/system-actuator']);
    }

    const output = safeExec('node', [actuatorPath, '--input', inputPath]);
    const result = JSON.parse(output);

    console.log('\n--- Governance Audit Summary ---');
    console.log(`Policy: ${result.policy_name}`);
    console.log(`Status: ${result.overall_status === 'passed' ? '✅ PASSED' : '❌ FAILED'}`);
    
    result.results.forEach((r: any) => {
      const icon = r.status === 'passed' ? '✅' : r.status === 'warning' ? '⚠️' : '❌';
      console.log(`${icon} ${r.id.padEnd(25)} : ${r.status.toUpperCase()}`);
      if (r.violations) {
        r.violations.forEach((v: string) => console.log(`  - ${v}`));
      }
      if (r.error) {
        console.log(`  - Error: ${r.error}`);
      }
    });

    if (result.overall_status !== 'passed') {
      process.exit(1);
    }
  } catch (err: any) {
    logger.error(`Audit failed: ${err.message}`);
    process.exit(1);
  } finally {
    if (fs.existsSync(inputPath)) {
      safeUnlinkSync(inputPath);
    }
  }
}

main();
