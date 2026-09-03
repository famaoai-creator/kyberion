import { isDirectEntry } from '@agent/core/direct-entry';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { runOpPreflight } from '@agent/core/op-preflight';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import {
  executePipeline,
  performReconcile,
  type ModelingAction,
} from './modeling-pipeline-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';
import { describeOps } from './op-catalog.js';

/**
 * Main Entry Point
 */
export async function handleAction(input: ModelingAction) {
  if (input.action === 'reconcile') {
    ensureDefaultOpPreflight();
    const preflight = await runOpPreflight({
      op: 'modeling:reconcile',
      params: input as unknown as Record<string, unknown>,
      source: 'actuator',
    });
    if (preflight.decision !== 'allow') {
      throw new Error(
        `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || 'Operation modeling:reconcile was not admitted.'}`
      );
    }
    input = { ...(input as any), ...preflight.input, action: 'reconcile' };
    return await performReconcile(input);
  }
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported action: ${input.action}`);
  }
  return await executePipeline(input.steps || [], input.context || {}, input.options);
}

/**
 * CLI Runner
 */
const main = async () => {
  await runActuatorCli({
    name: 'modeling-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/modeling-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'modeling-actuator');
}

export const actuator = defineCatalogBackedActuator({
  id: 'modeling-actuator',
  describeOps,
  handleAction,
});
export { describeOps };
