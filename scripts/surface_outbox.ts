#!/usr/bin/env node

import { createStandardYargs } from '@agent/core/cli-utils';
import { isSurfaceAsyncChannel } from '@agent/core/channel-surface-types';
import {
  listSurfaceDeadLetters,
  replaySurfaceDeadLetter,
} from '@agent/core/surface-coordination-store';
import { defineScript, isDirectScript } from './lib/harness.js';

type SurfaceOutboxCommand = 'list' | 'replay';

export function runSurfaceOutbox(args: string[] = []): number {
  const commandToken = args[0] && !args[0].startsWith('-') ? args[0] : undefined;
  const command = (commandToken || 'list') as SurfaceOutboxCommand;
  if (command !== 'list' && command !== 'replay') {
    throw new Error(`Unknown surface-outbox command: ${command}`);
  }
  const optionArgs = commandToken ? args.slice(1) : args;
  const argv = createStandardYargs(['node', 'surface_outbox', ...optionArgs])
    .scriptName('surface-outbox')
    .usage('$0 <list|replay> --surface <surface> [options]')
    .option('surface', {
      type: 'string',
      demandOption: true,
      describe: 'Surface name, such as slack, telegram, discord, or imessage',
    })
    .option('dead-letter-id', {
      type: 'string',
      describe: 'Dead-letter ID required for replay',
    })
    .option('operator-id', {
      type: 'string',
      describe: 'Audited operator identity required for replay',
    })
    .option('dedup-key', {
      type: 'string',
      describe: 'Optional replacement deduplication key for replay',
    })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const surface = String(argv.surface || '')
    .trim()
    .toLowerCase();
  if (!isSurfaceAsyncChannel(surface)) {
    throw new Error(`Surface "${surface}" is not registered in the surface manifest.`);
  }
  if (command === 'list') {
    const records = listSurfaceDeadLetters(surface);
    if (argv.json) {
      process.stdout.write(`${JSON.stringify({ surface, dead_letters: records }, null, 2)}\n`);
    } else if (records.length === 0) {
      process.stdout.write(`No surface dead-letters for ${surface}.\n`);
    } else {
      for (const record of records) {
        process.stdout.write(
          `${record.dead_letter_id} | ${record.channel} | ${record.failure.kind} | replays=${record.replay_count || 0}\n`
        );
      }
    }
    return 0;
  }

  const deadLetterId = String(argv['dead-letter-id'] || '').trim();
  const operatorId = String(argv['operator-id'] || '').trim();
  if (!deadLetterId || !operatorId) {
    throw new Error('surface-outbox replay requires --dead-letter-id and --operator-id.');
  }
  const messagePath = replaySurfaceDeadLetter(surface, deadLetterId, {
    operatorId,
    deduplicationKey: argv['dedup-key'] ? String(argv['dedup-key']) : undefined,
  });
  const result = { surface, dead_letter_id: deadLetterId, replayed_message_path: messagePath };
  if (argv.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`Requeued ${deadLetterId}: ${messagePath}\n`);
  return 0;
}

export const main = defineScript({
  name: 'surface-outbox',
  flags: [],
  run(context) {
    const status = runSurfaceOutbox(context.argv);
    if (status !== 0) throw new Error(`surface-outbox failed with exit code ${status}`);
  },
});

if (
  isDirectScript(import.meta.url, 'surface_outbox.ts') ||
  isDirectScript(import.meta.url, 'surface_outbox.js')
)
  void main();
