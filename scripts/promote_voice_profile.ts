import { createStandardYargs, promoteVoiceProfileFromReceipt } from '@agent/core';

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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
