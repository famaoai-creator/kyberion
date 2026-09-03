import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { isDirectEntry } from '@agent/core/direct-entry';
import { readJson } from '@agent/core/foundation';
import * as pathResolver from '@agent/core/path-resolver';
import { handleAction } from './process-actuator-helpers.js';
import { parseProcessAction } from './process-action-input.js';

async function main() {
  const processActionSchema = readJson<Record<string, unknown>>(
    pathResolver.rootResolve('knowledge/product/schemas/process-action.schema.json')
  );
  await runActuatorCli({
    name: 'process-actuator',
    args: currentProcessArgv(),
    handleAction,
    schema: processActionSchema,
  });
}

export const actuator = defineCatalogBackedActuator({
  id: 'process-actuator',
  describeOps,
  handleAction: (input) => handleAction(parseProcessAction(input)),
});

export { handleAction, parseProcessAction };

if (isDirectEntry(import.meta.url, 'libs/actuators/process-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'process-actuator');
}
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
