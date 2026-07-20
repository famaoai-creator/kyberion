import { createStandardYargs, logger, safeReadFile } from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathResolver } from '@agent/core';
import { handleApprovalAction } from './approval-actuator-helpers.js';
import { runActuatorCli } from '@agent/core';
export { handleApprovalAction as handleAction } from './approval-actuator-helpers.js';
export { describeOps } from './op-catalog.js';
export { evaluateDecisionRightsOp, requestReviewOp } from './approval-ops.js';

const main = async () => {
  await runActuatorCli({
    name: 'approval-actuator',
    handleAction: handleApprovalAction,
  });
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}
