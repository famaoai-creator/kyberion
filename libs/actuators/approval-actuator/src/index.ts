import { logger } from '@agent/core/core';
import { isDirectEntry } from '@agent/core/direct-entry';
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

if (isDirectEntry(import.meta.url, 'libs/actuators/approval-actuator/src/index.ts')) {
  main().catch((err) => {
    logger.error(err.message);
    process.exitCode = 1;
  });
}
