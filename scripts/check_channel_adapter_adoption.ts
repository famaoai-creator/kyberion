import { pathResolver, safeReadFile } from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

const BRIDGES = [
  'satellites/slack-bridge/src/index.ts',
  'satellites/telegram-bridge/src/index.ts',
  'satellites/discord-bridge/src/index.ts',
  'satellites/imessage-bridge/src/index.ts',
] as const;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');
}

export function checkChannelAdapterAdoption(): string[] {
  const failures: string[] = [];
  for (const relative of BRIDGES) {
    const source = stripComments(
      String(safeReadFile(pathResolver.rootResolve(relative), { encoding: 'utf8' }) || '')
    );
    if (!/\brunChannelTurn\s*\(/u.test(source)) {
      failures.push(`${relative}: missing executable runChannelTurn call`);
    }
    if (!/\bChannelAdapter\b/u.test(source)) failures.push(`${relative}: missing ChannelAdapter`);
    if (/send\s*:\s*async\s*\(\)\s*=>\s*undefined/u.test(source)) {
      failures.push(`${relative}: send must deliver or explicitly defer a turn`);
    }
    if (!/shouldSend\s*:/u.test(source)) {
      failures.push(`${relative}: missing explicit proposal/approval delivery gate`);
    }
    if (
      (relative.includes('discord') || relative.includes('telegram')) &&
      !/\bformatChannelThreadContext\b/u.test(source)
    ) {
      failures.push(`${relative}: missing shared formatChannelThreadContext import`);
    }
    const deliveryEvidence =
      /sendTelegramMessage|replyDiscordText|postSlackText|sendIMessageText/u.test(source);
    if (!deliveryEvidence) {
      failures.push(`${relative}: adapter send lacks provider delivery evidence`);
    }
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
