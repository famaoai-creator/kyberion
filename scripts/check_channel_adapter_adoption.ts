import { pathResolver, safeReadFile } from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

const BRIDGES = [
  'satellites/slack-bridge/src/index.ts',
  'satellites/telegram-bridge/src/index.ts',
  'satellites/discord-bridge/src/index.ts',
  'satellites/imessage-bridge/src/index.ts',
] as const;

export function checkChannelAdapterAdoption(): string[] {
  const failures: string[] = [];
  for (const relative of BRIDGES) {
    const source = String(
      safeReadFile(pathResolver.rootResolve(relative), { encoding: 'utf8' }) || ''
    );
    if (!/\brunChannelTurn\b/u.test(source)) failures.push(`${relative}: missing runChannelTurn`);
    if (!/\bChannelAdapter\b/u.test(source)) failures.push(`${relative}: missing ChannelAdapter`);
  }
  return failures;
}

export const runCheckChannelAdapterAdoption = defineScript({
  name: 'check:channel-adapter-adoption',
  flags: [],
  run(context) {
    const failures = checkChannelAdapterAdoption();
    if (failures.length) {
      console.error('[check:channel-adapter-adoption] FAILED');
      for (const failure of failures) console.error(`- ${failure}`);
      process.exitCode = 1;
      return;
    }
    context.print(`[check:channel-adapter-adoption] OK (${BRIDGES.length} bridges)`);
  },
});

if (
  isDirectScript(import.meta.url, 'check_channel_adapter_adoption.ts') ||
  isDirectScript(import.meta.url, 'check_channel_adapter_adoption.js')
)
  void runCheckChannelAdapterAdoption();
