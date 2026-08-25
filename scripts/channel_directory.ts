#!/usr/bin/env node
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  formatChannelDirectoryEntry,
  getChannelDirectoryEntry,
  listChannelDirectoryEntries,
  isSurfaceAsyncChannel,
} from '@agent/core';
import { isDirectScript } from './lib/harness.js';

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('channel', {
      type: 'string',
      describe:
        'Limit output to a single surface channel such as slack, imessage, discord, telegram, chronos, or presence',
    })
    .option('json', { type: 'boolean', default: false })
    .parseSync();

  const entries = argv.channel
    ? (() => {
        const channel = String(argv.channel).trim().toLowerCase();
        if (!isSurfaceAsyncChannel(channel)) {
          throw new Error(`Channel "${channel}" is not registered in the surface manifest.`);
        }
        const entry = getChannelDirectoryEntry(channel);
        if (!entry) {
          throw new Error(
            `Channel "${String(argv.channel)}" was not found. Try one of: ${listChannelDirectoryEntries()
              .map((item) => item.channel)
              .join(', ')}`
          );
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

if (
  isDirectScript(import.meta.url, 'channel_directory.ts') ||
  isDirectScript(import.meta.url, 'channel_directory.js')
)
  void main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exitCode = 1;
  });
