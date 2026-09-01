import { createStandardYargs } from '@agent/core/cli-utils';
import { promoteVoiceProfileFromReceipt } from '@agent/core/voice-profile-promotion';
import { defineScript, isDirectScript } from './lib/harness.js';

async function main(args: string[] = []) {
  const argv = await createStandardYargs(['node', 'promote_voice_profile', ...args])
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
  return result;
}

export const runPromoteVoiceProfile = defineScript({
  name: 'voice:promote-profile',
  flags: [],
  run: async ({ argv, print }) => {
    const result = await main(argv);
    print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'promote_voice_profile.ts') ||
  isDirectScript(import.meta.url, 'promote_voice_profile.js')
)
  void runPromoteVoiceProfile();
