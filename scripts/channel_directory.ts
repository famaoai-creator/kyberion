#!/usr/bin/env node
import { createStandardYargs } from '@agent/core/cli-utils';
import { formatChannelDirectoryEntry, getChannelDirectoryEntry, listChannelDirectoryEntries } from '@agent/core';

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('channel', {
      type: 'string',
      describe: 'Limit output to a single surface channel such as slack, imessage, discord, telegram, chronos, or presence',
    })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const entries = argv.channel
    ? (() => {
      const entry = getChannelDirectoryEntry(String(argv.channel));
      if (!entry) {
        throw new Error(`Channel "${String(argv.channel)}" was not found. Try one of: ${listChannelDirectoryEntries().map((item) => item.channel).join(', ')}`);
      }
      return [entry];
    })()
    : listChannelDirectoryEntries();

  if (argv.json) {
    console.log(JSON.stringify({ status: 'ok', entries }, null, 2));
    return;
  }

  if (entries.length === 0) {
    console.log('No channel directory entries found.');
    return;
  }

  console.log('Channel directory:');
  for (const entry of entries) {
    console.log(`- ${entry.displayName} (${entry.channel})`);
    for (const line of formatChannelDirectoryEntry(entry)) {
      console.log(`  ${line}`);
    }
  }
}

const isDirect = process.argv[1] && /channel_directory\.(ts|js)$/.test(process.argv[1]);
if (isDirect) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
