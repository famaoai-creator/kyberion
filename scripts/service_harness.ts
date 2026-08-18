#!/usr/bin/env node
import { createStandardYargs, logger } from '@agent/core';
import { handleAction } from '../libs/actuators/service-actuator/src/service-actuator-helpers.js';

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

async function main(): Promise<void> {
  // pnpm passes the conventional separator through to the script. Remove it
  // so `pnpm run service:harness -- --service ...` behaves like direct Node
  // execution while preserving yargs' normal option parsing.
  if (process.argv[2] === '--') process.argv.splice(2, 1);

  const argv = await createStandardYargs()
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

  try {
    const result = await handleAction({
      service_id: String(argv.service),
      mode: 'HARNESS',
      action,
      params,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] && /service_harness\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
