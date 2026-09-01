import { logger } from '@agent/core/core';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { runOpPreflight } from '@agent/core/op-preflight';
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import {
  executePipeline,
  performReconcile,
  type ModelingAction,
} from './modeling-pipeline-helpers.js';
import { runActuatorCli } from '@agent/core/cli-utils';
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
    args: process.argv,
    handleAction,
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

export const actuator = defineCatalogBackedActuator({
  id: 'modeling-actuator',
  describeOps,
  handleAction,
});
export { describeOps };
