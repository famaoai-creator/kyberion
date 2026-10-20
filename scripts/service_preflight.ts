#!/usr/bin/env node
/** CLI compatibility wrapper for the canonical service preflight operation. */
import { createStandardYargs } from '@agent/core/cli-utils';
import { runServicePreflight } from '@agent/core/service/service-preflight';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export { parseJsonProbeOutput, runServicePreflight } from '@agent/core/service/service-preflight';

function formatHumanReport(report: Awaited<ReturnType<typeof runServicePreflight>>): string {
  return [
    ...report.reports.flatMap((item) => [
      `[service-preflight] ${item.serviceId}: ${item.status}`,
      `  auth=${item.authReady ? 'yes' : 'no'} direct=${item.directProbeReady === null ? 'n/a' : item.directProbeReady ? 'yes' : 'no'} runtime=${item.runtimeReady ? 'yes' : 'no'}`,
      `  reason=${item.reason}`,
    ]),
    '',
  ].join('\n');
}

async function main(args: string[] = []): Promise<Awaited<ReturnType<typeof runServicePreflight>>> {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  const argv = await createStandardYargs(['node', 'service_preflight', ...normalizedArgs])
    .option('service', { type: 'string', describe: 'Service id to preflight' })
    .option('all', { type: 'boolean', default: false })
    .parseSync();

  return runServicePreflight({
    serviceId: argv.service ? String(argv.service) : undefined,
    all: Boolean(argv.all),
  });
}

if (
  isDirectScript(import.meta.url, 'service_preflight.ts') ||
  isDirectScript(import.meta.url, 'service_preflight.js')
)
  void defineScript({
    name: 'service:preflight',
    async run(context) {
      const report = await main(context.argv);
      context.print(context.json ? { status: 'ok', report } : formatHumanReport(report));
      if (!report.ready) {
        throw new ScriptExitError(1, '', true, report);
      }
      return report;
    },
  })();
