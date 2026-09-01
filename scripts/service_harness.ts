#!/usr/bin/env node
import { createStandardYargs } from '@agent/core/cli-utils';
import { handleAction } from '../libs/actuators/service-actuator/src/service-actuator-helpers.js';
import { defineScript, isDirectScript, stripSharedScriptFlags } from './lib/harness.js';

type HarnessAction = 'describe' | 'plan' | 'verify' | 'receipt';

function parseObject(value: string, name: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`--${name} ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function main(
  args: string[] = [],
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  // pnpm passes the conventional separator through to the script. Remove it
  // so `pnpm kyberion service harness --service ...` behaves like direct Node
  // execution while preserving yargs' normal option parsing.
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;

  const argv = await createStandardYargs(['node', 'service_harness', ...normalizedArgs])
    .option('service', { type: 'string', demandOption: true, describe: 'Service id' })
    .option('action', {
      type: 'string',
      choices: ['describe', 'plan', 'verify', 'receipt'] as const,
      default: 'describe',
      describe: 'Side-effect-free harness action',
    })
    .option('operation', { type: 'string', describe: 'Service operation for plan/verify/receipt' })
    .option('inputs', {
      type: 'string',
      default: '{}',
      describe: 'Operation inputs as JSON object',
    })
    .option('result', { type: 'string', default: '{}', describe: 'Observed result as JSON object' })
    .option('detail', {
      type: 'boolean',
      default: true,
      describe: 'Include full operation details for describe',
    })
    .option('persist', {
      type: 'boolean',
      default: false,
      describe: 'Persist a receipt under the governed runtime root',
    })
    .parse();

  const action = String(argv.action) as HarnessAction;
  const params: Record<string, unknown> = {};
  if (action === 'describe') {
    params.detail = Boolean(argv.detail);
  } else {
    params.operation = argv.operation ? String(argv.operation) : '';
    params.inputs = parseObject(String(argv.inputs), 'inputs');
    if (action === 'verify' || action === 'receipt')
      params.result = parseObject(String(argv.result), 'result');
    if (action === 'receipt') params.persist = Boolean(argv.persist);
  }

  const result = await handleAction({
    service_id: String(argv.service),
    mode: 'HARNESS',
    action,
    params,
  });
  print(result);
}

export const runServiceHarness = defineScript({
  name: 'service:harness',
  flags: ['json', 'quiet'],
  run: ({ argv, print }) => main(stripSharedScriptFlags(argv), print),
});

if (
  isDirectScript(import.meta.url, 'service_harness.ts') ||
  isDirectScript(import.meta.url, 'service_harness.js')
)
  void runServiceHarness();
