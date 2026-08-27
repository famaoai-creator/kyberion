import { loadJson, logger, pathResolver, defineCatalogBackedActuator } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { handleAction } from './wisdom-pipeline-helpers.js';
import { describeOps } from './op-catalog.js';
import { runActuatorCli } from '@agent/core';

const main = async () => {
  const schema = loadJson<object>(
    pathResolver.rootResolve('knowledge/product/schemas/wisdom-action.schema.json')
  );
  await runActuatorCli({
    name: 'wisdom-actuator',
    handleAction,
    schema,
  });
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
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
