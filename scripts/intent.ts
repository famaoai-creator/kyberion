import { createStandardYargs } from '@agent/core/cli-utils';
import { collectIntentTraceEvidence, formatTraceReport } from './intent_trace.js';

async function main(): Promise<void> {
  const argv = await createStandardYargs()
    .option('locale', {
      type: 'string',
      description: 'Locale for user-facing status text',
      default: 'en',
    })
    .help()
    .parse();

  const subcommand = String(argv._[0] || '').trim();
  const correlationId = String(argv._[1] || '').trim();
  const locale = String(argv.locale || 'en').trim() || 'en';

  if (subcommand !== 'trace' || !correlationId) {
    console.error('Usage: pnpm intent trace <correlation_id> [--locale en|ja]');
    process.exit(1);
  }

  const evidence = collectIntentTraceEvidence(correlationId, { locale });
  console.log(formatTraceReport(evidence, locale));
}

void main();
