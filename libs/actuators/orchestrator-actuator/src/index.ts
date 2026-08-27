import { loadJson, logger, safeExistsSync } from '@agent/core';
import { pathResolver } from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executePipeline, type PipelineStep } from './orchestrator-helpers.js';
import { runActuatorCli } from '@agent/core';

/**
 * Orchestrator-Actuator v2.1.0 [AUTONOMOUS CONTROL ENABLED]
 * Strictly compliant with Layer 2 (Shield).
 * Unified ADF-driven engine for Mission & Task Management with Control Flow.
 */

interface OrchestratorAction {
  action: 'pipeline' | 'reconcile';
  steps?: PipelineStep[];
  strategy_path?: string;
  context?: Record<string, any>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
}

interface StrategyConfig {
  strategies: Array<{ pipeline: PipelineStep[]; params?: Record<string, unknown> }>;
}

async function handleAction(input: OrchestratorAction) {
  if (input.action === 'reconcile') {
    return await performReconcile(input);
  }
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported orchestrator action: ${input.action}`);
  }
  return await executePipeline(input.steps || [], input.context || {}, input.options);
}

async function performReconcile(input: OrchestratorAction) {
  const strategyPath = pathResolver.rootResolve(
    input.strategy_path || 'knowledge/product/governance/orchestration-strategy.json'
  );
  if (!safeExistsSync(strategyPath)) throw new Error(`Strategy not found: ${strategyPath}`);
  const config = loadJson<StrategyConfig>(strategyPath);
  for (const strategy of config.strategies) {
    await executePipeline(strategy.pipeline, strategy.params || {}, input.options);
  }
  return { status: 'reconciled' };
}

const main = async () => {
  await runActuatorCli({
    name: 'orchestrator-actuator',
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

export { handleAction };

export const actuator = defineCatalogBackedActuator({
  id: 'orchestrator-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
