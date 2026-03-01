#!/usr/bin/env node
/**
 * Presence Reply Utility v1.0
 * Convenience tool for the Agent to resolve sensory stimuli and send replies.
 */

const { logger, requireRole } = require('./system-prelude.cjs');
const presence = require('../presence/bridge/presence-controller.cjs');

requireRole('Ecosystem Architect');

async function main() {
  const args = process.argv.slice(2);
  const timestamp = args[0];
  const response = args.slice(1).join(' ');

  if (!timestamp || !response) {
    console.log('Usage: node presence_reply.cjs <timestamp> <response text>');
    process.exit(1);
  }

  logger.info(`📝 Resolving stimulus from ${timestamp}...`);
  try {
    await presence.resolveStimulus(timestamp, response);
    logger.success('✅ Stimulus resolved and reply routed.');
  } catch (err) {
    logger.error(`Failed to reply: ${err.message}`);
    process.exit(1);
  }
}

main();
