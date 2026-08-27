import { logger } from '@agent/core';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { handleSystemAction } from './system-action-helpers.js';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runActuatorCli } from '@agent/core';
import { describeOps } from './op-catalog.js';
export { describeOps };
export {
  SYSTEM_ACTUATOR_CAPTURE_OPS,
  SYSTEM_ACTUATOR_APPLY_OPS,
  SYSTEM_ACTUATOR_TRANSFORM_OPS,
  SYSTEM_ACTUATOR_CONTROL_OPS,
} from './op-catalog.js';

/**
 * System-Actuator v2.1.0 [AUTONOMOUS CONTROL ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 * Standardized with Control Flow (if/while) and Safety Guards.
 */

/**
 * Main Entry Point
 */
/**
 * Universal Pipeline Engine with Control Flow & Safety Guards
 * moved to system-pipeline-helpers.ts
 */

/**
 * CLI Runner
 */
const main = async () => {
  await runActuatorCli({
    name: 'system-actuator',
    handleAction: handleSystemAction,
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

export { handleSystemAction as handleAction };
export const actuator = defineCatalogBackedActuator({
  id: 'system-actuator',
  describeOps,
  handleAction: (input) =>
    handleSystemAction(input as unknown as Parameters<typeof handleSystemAction>[0]),
});
