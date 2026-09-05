import { pathResolver } from '@agent/core/path-resolver';
import { readTextFile } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const BRIDGES = [
  'satellites/slack-bridge/src/index.ts',
  'satellites/telegram-bridge/src/index.ts',
  'satellites/discord-bridge/src/index.ts',
  'satellites/imessage-bridge/src/index.ts',
] as const;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');
}

export function hasSharedThreadFormatterImport(source: string): boolean {
  return /import\s*\{[\s\S]*\bformatChannelThreadContext\b[\s\S]*\}\s*from\s*['"]@agent\/core\/channel-adapter['"]/u.test(
    source
  );
}

export function checkChannelAdapterAdoption(): string[] {
  const failures: string[] = [];
  for (const relative of BRIDGES) {
    const source = stripComments(readTextFile(pathResolver.rootResolve(relative)));
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
    if (!hasSharedThreadFormatterImport(source)) {
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
      throw new ScriptExitError(
        1,
        [
          'channel adapter adoption check failed',
          ...failures.map((failure) => `- ${failure}`),
        ].join('\n')
      );
    }
    context.print(`[check:channel-adapter-adoption] OK (${BRIDGES.length} bridges)`);
    return { bridges: BRIDGES.length, failures };
  },
});

if (
  isDirectScript(import.meta.url, 'check_channel_adapter_adoption.ts') ||
  isDirectScript(import.meta.url, 'check_channel_adapter_adoption.js')
)
  void runCheckChannelAdapterAdoption();
