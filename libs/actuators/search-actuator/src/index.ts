import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './search-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { defineCatalogBackedActuator } from '../../../core/actuator/actuator-sdk.js';
import { describeOps } from './op-catalog.js';

export const actuator = defineCatalogBackedActuator({
  id: 'search-actuator',
  describeOps,
  handleAction,
  actionInput: (op, params) => ({ op, params }),
});

const main = async () => {
  await runActuatorCli({
    name: 'search-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/search-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'search-actuator');
}

export { handleAction, webSearch, fetchReader } from './search-helpers.js';
export type { SearchAction, WebSearchStub, FetchReaderResult } from './search-helpers.js';
