#!/usr/bin/env node
/**
 * Visual Auto-Heal v1.0
 * Integrates Sight with Repair logic. Captures screenshots on failure.
 */

const { logger, pathResolver, safeExec } = require('./system-prelude.cjs');
const visualSensor = require('../presence/sensors/visual-sensor.cjs');

async function autoHeal(command, args = []) {
  logger.info(`🛠️ Running repair command with visual monitoring: ${command} ${args.join(' ')}`);
  
  try {
    safeExec(command, args);
    logger.success('✅ Command succeeded. No visual evidence needed.');
  } catch (err) {
    logger.error(`❌ Command failed: ${err.message}. Capturing visual evidence...`);
    
    try {
      const artifact = await visualSensor.capture('screen');
      logger.info(`📸 Visual evidence stored: ${artifact.path}`);
      
      // Future: Pass artifact to multimodal brain for repair strategy
      console.log(`
[SIGHT_ADVICE]: Visual state captured. Ready for multimodal analysis.
`);
    } catch (vErr) {
      logger.error(`Failed to capture visual evidence: ${vErr.message}`);
    }
    
    process.exit(1);
  }
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.log('Usage: node visual_auto_heal.cjs <command> [args...]');
  process.exit(1);
}

autoHeal(cmd, args);
