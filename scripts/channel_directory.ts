#!/usr/bin/env node
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  formatChannelDirectoryEntry,
  getChannelDirectoryEntry,
  listChannelDirectoryEntries,
} from '@agent/core/channel-directory';
import type { ChannelDirectoryEntry } from '@agent/core/channel-directory';
import { isSurfaceAsyncChannel } from '@agent/core/channel-surface-types';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';

export function resolveChannelDirectoryEntries(channel: unknown): ChannelDirectoryEntry[] {
  if (channel === undefined) return listChannelDirectoryEntries();
  if (typeof channel !== 'string') throw new Error('channel must be a string');
  const normalized = channel.trim().toLowerCase();
  if (!isSurfaceAsyncChannel(normalized)) {
    throw new Error(`Channel "${normalized}" is not registered in the surface manifest.`);
  }
  const entry = getChannelDirectoryEntry(normalized);
  if (!entry) {
    throw new Error(
      `Channel "${channel}" was not found. Try one of: ${listChannelDirectoryEntries()
        .map((item) => item.channel)
        .join(', ')}`
    );
  }
  return [entry];
}

export function renderChannelDirectory(entries: ChannelDirectoryEntry[]): string {
  if (entries.length === 0) return 'No channel directory entries found.';
  const lines = ['Channel directory:'];
  for (const entry of entries) {
    lines.push(`- ${entry.displayName} (${entry.channel})`);
    for (const line of formatChannelDirectoryEntry(entry)) lines.push(`  ${line}`);
  }
  return lines.join('\n');
}

async function main(args: string[], print: (value: unknown) => void, json: boolean): Promise<void> {
  const argv = await createStandardYargs([
    'node',
    'channel_directory',
    ...stripSharedScriptFlags(args),
  ])
    .option('channel', {
      type: 'string',
      describe:
        'Limit output to a single surface channel such as slack, imessage, discord, telegram, chronos, or presence',
    })
    .parseSync();

  const entries = resolveChannelDirectoryEntries(argv.channel);

  if (json) {
    print({ status: 'ok', entries });
    return;
  }
  print(renderChannelDirectory(entries));
}

export const runChannelDirectory = defineScript({
  name: 'channel-directory',
  flags: ['json', 'quiet'],
  run: ({ argv, print, json }) => main(argv, print, json),
});

if (
  isDirectScript(import.meta.url, 'channel_directory.ts') ||
  isDirectScript(import.meta.url, 'channel_directory.js')
)
  void runChannelDirectory();
