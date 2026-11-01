import { isDirectEntry } from '@agent/core/direct-entry';
import { handleAction } from './search-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { defineCatalogBackedActuator } from '@agent/core/actuator/actuator-sdk';
import { describeOps } from './op-catalog.js';
import './web-search-runtime-stub.js';
import './web-search-runtime-rustxng.js';

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
export type {
  SearchAction,
  WebSearchStub,
  WebSearchResult,
  FetchReaderResult,
} from './search-helpers.js';
