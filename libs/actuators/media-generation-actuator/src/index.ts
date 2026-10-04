import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './media-generation-action-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { defineCatalogBackedActuator } from '../../../core/actuator/actuator-sdk.js';
import { describeOps } from './op-catalog.js';

const main = async () => {
  await runActuatorCli({
    name: 'media-generation-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/media-generation-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'media-generation-actuator');
}

export { handleAction };
export { registerGenerationProviderHistoryClient } from './generation-provider-clients.js';
export { registerGenerationHistoryAdapter } from './generation-artifact-adapters.js';
export type { GenerationHistoryAdapter } from './generation-artifact-adapters.js';
export type { GenerationModality } from './media-generation-helpers.js';
export type {
  GenerationProviderHistoryClient,
  GenerationProviderHistoryClientFactory,
} from './generation-provider-clients.js';
export { registerDirectVideoProviderAdapter } from './video-generation-provider.js';
export type {
  DirectVideoFeatures,
  DirectVideoProviderAdapter,
  VideoGenerationProvider,
} from './video-generation-provider.js';

export const actuator = defineCatalogBackedActuator({
  id: 'media-generation-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});
