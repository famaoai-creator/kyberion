/**
 * scripts/pulse_trigger.ts
 * Bridges OS cron/timers to the Gemini sensory system.
 * Usage: node dist/scripts/pulse_trigger.js --type routine --payload daily-routine
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeWriteFile, pathResolver } from '@agent/core';

const STIMULI_PATH = pathResolver.resolve('presence/bridge/stimuli.jsonl');

async function main() {
  const args = process.argv.slice(2);
  const typeArg = args.find(a => a.startsWith('--type='))?.split('=')[1] || 'routine';
  const payloadArg = args.find(a => a.startsWith('--payload='))?.split('=')[1] || 'ping';
  const priorityArg = args.find(a => a.startsWith('--priority='))?.split('=')[1] || '2';

  const stimulus = {
    timestamp: new Date().toISOString(),
    source_channel: 'system_cron',
    delivery_mode: 'IMMEDIATE',
    type: typeArg,
    payload: payloadArg,
    status: 'PENDING',
    metadata: {
      priority: parseInt(priorityArg, 10),
      triggered_by: 'cron'
    }
  };

  // Ensure directory exists
  const dir = path.dirname(STIMULI_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Append to stimuli.jsonl
  fs.appendFileSync(STIMULI_PATH, JSON.stringify(stimulus) + '\n');
  
  console.log(`[Pulse] Stimulus triggered: ${typeArg} -> ${payloadArg} (Priority: ${priorityArg})`);
}

main().catch(err => {
  console.error(`[Pulse] Failed to trigger: ${err.message}`);
  process.exit(1);
});
