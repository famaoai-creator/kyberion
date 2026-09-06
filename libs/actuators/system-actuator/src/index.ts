import { isDirectEntry } from '@agent/core/direct-entry';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { handleSystemAction } from './system-action-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
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
    args: currentProcessArgv(),
    handleAction: handleSystemAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/system-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'system-actuator');
}

export { handleSystemAction as handleAction };
export const actuator = defineCatalogBackedActuator({
  id: 'system-actuator',
  describeOps,
  handleAction: (input) =>
    handleSystemAction(input as unknown as Parameters<typeof handleSystemAction>[0]),
});
