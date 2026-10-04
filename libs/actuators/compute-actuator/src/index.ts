import { isDirectEntry } from '@agent/core/direct-entry';
import { defineCatalogBackedActuator } from '../../../core/actuator/actuator-sdk.js';
import { handleAction } from './compute-actuator-helpers.js';
import { describeOps } from './op-catalog.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import './local-compute-driver.js';
import './colab-compute-driver.js';

export const actuator = defineCatalogBackedActuator({
  id: 'compute-actuator',
  describeOps,
  handleAction,
  actionInput: (op, params) => ({ action: op, params }),
});

const main = async () => {
  await runActuatorCli({
    name: 'compute-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/compute-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'compute-actuator');
}

export { handleAction };
export {
  getComputeDriver,
  listComputeProviders,
  registerComputeDriver,
  resolveDriverForJob,
} from './compute-driver.js';
export type { ComputeDriver, ComputeJobSpec, ComputeJobState } from './compute-driver.js';
