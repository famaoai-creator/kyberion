import { pathResolver, safeReadFile } from '@agent/core';

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

export function main(): number {
  const failures = checkChannelAdapterAdoption();
  if (failures.length) {
    console.error('[check:channel-adapter-adoption] FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    return 1;
  }
  console.log(`[check:channel-adapter-adoption] OK (${BRIDGES.length} bridges)`);
  return 0;
}

if (process.argv[1]?.endsWith('check_channel_adapter_adoption.ts')) process.exitCode = main();
