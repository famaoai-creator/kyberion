import { isDirectEntry } from '@agent/core/direct-entry';
import { defineCatalogBackedActuator } from '../../../core/actuator/actuator-sdk.js';
import { handleAction } from './network-pipeline-helpers.js';
import { describeOps } from './op-catalog.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';

export const actuator = defineCatalogBackedActuator({
  id: 'network-actuator',
  describeOps,
  handleAction,
});

const main = async () => {
  await runActuatorCli({
    name: 'network-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/network-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'network-actuator');
}

export { handleAction };

export { describeOps } from './op-catalog.js';
export { registerA2ATransport, listA2ATransportMethods } from './a2a-transport.js';
export type {
  A2ATransport,
  A2ATransportPacket,
  A2ATransportOptions,
  A2AEnvelope,
  A2AInboxMessage,
} from './a2a-transport.js';
