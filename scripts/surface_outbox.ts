#!/usr/bin/env node

import {
  createStandardYargs,
  listSurfaceDeadLetters,
  logger,
  replaySurfaceDeadLetter,
} from '@agent/core';

type SurfaceOutboxCommand = 'list' | 'replay';

export function runSurfaceOutbox(args = process.argv.slice(2)): number {
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

const isDirect = process.argv[1] && /surface_outbox\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  try {
    process.exit(runSurfaceOutbox());
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
