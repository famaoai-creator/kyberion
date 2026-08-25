import { createStandardYargs, promoteVoiceProfileFromReceipt } from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

async function main() {
  const argv = await createStandardYargs()
    .option('receipt', { type: 'string', demandOption: true })
    .option('approved-by', { type: 'string', demandOption: true })
    .option('target-status', {
      type: 'string',
      choices: ['active', 'shadow'] as const,
      default: 'active',
    })
    .option('set-default', { type: 'boolean', default: false })
    .parse();

  const result = promoteVoiceProfileFromReceipt({
    receiptPath: String(argv.receipt),
    approvedBy: String(argv['approved-by']),
    targetStatus: argv['target-status'] as 'active' | 'shadow',
    setAsDefault: Boolean(argv['set-default']),
  });

  console.log(JSON.stringify(result, null, 2));
}

export const runPromoteVoiceProfile = defineScript({
  name: 'voice:promote-profile',
  flags: [],
  run() {
    return main();
  },
});

if (
  isDirectScript(import.meta.url, 'promote_voice_profile.ts') ||
  isDirectScript(import.meta.url, 'promote_voice_profile.js')
)
  void runPromoteVoiceProfile();
