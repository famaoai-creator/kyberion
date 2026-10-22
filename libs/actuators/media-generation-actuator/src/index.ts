import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction as handleGenerationAction } from './media-generation-action-helpers.js';
import { handleCaptureAction } from './capture-actions.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { defineCatalogBackedActuator } from '@agent/core/actuator/actuator-sdk';
import { describeOps } from './op-catalog.js';

export const handleAction = (input: Parameters<typeof handleGenerationAction>[0]) =>
  handleGenerationAction(input, { capture: handleCaptureAction });

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
