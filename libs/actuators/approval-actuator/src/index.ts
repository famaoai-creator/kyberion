import { logger } from '@agent/core/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApprovalAction } from './approval-actuator-helpers.js';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
import { runActuatorCli } from '@agent/core/cli-utils';
export { handleApprovalAction as handleAction } from './approval-actuator-helpers.js';

export const actuator = defineCatalogBackedActuator({
  id: 'approval-actuator',
  describeOps,
  handleAction: handleApprovalAction,
});
export { describeOps } from './op-catalog.js';
export { evaluateDecisionRightsOp, requestReviewOp } from './approval-ops.js';

const main = async () => {
  await runActuatorCli({
    name: 'approval-actuator',
    args: process.argv,
    handleAction: handleApprovalAction,
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
