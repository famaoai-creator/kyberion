import { readJson } from '@agent/core/foundation';
import { logger } from '@agent/core/core';
import { isDirectEntry } from '@agent/core/direct-entry';
import { pathResolver } from '@agent/core/path-resolver';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { handleAction } from './wisdom-pipeline-helpers.js';
import { describeOps } from './op-catalog.js';
import { runActuatorCli } from '@agent/core/cli-utils';

const main = async () => {
  const schema = readJson<object>(
    pathResolver.rootResolve('knowledge/product/schemas/wisdom-action.schema.json')
  );
  await runActuatorCli({
    name: 'wisdom-actuator',
    args: process.argv,
    handleAction,
    schema,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/wisdom-actuator/src/index.ts')) {
  main().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}

export { handleAction } from './wisdom-pipeline-helpers.js';
export const actuator = defineCatalogBackedActuator({
  id: 'wisdom-actuator',
  describeOps,
  handleAction,
});
export { dispatchWisdomOperation } from './decision-ops.js';
export { createWisdomDispatcher } from './wisdom-dispatcher.js';
export type { WisdomContext } from './contracts/wisdom-context.js';
export type { ExecutionKind, IdempotencyClass, WisdomReceipt } from './contracts/wisdom-result.js';
export type { WisdomOperationSpec } from './contracts/wisdom-operation.js';
export { validateWisdomRequest } from './contracts/wisdom-request.js';

export { describeOps };
