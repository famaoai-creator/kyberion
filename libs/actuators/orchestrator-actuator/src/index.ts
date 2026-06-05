import { logger, safeExistsSync, safeReadFile } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import { pathResolver } from '@agent/core';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  executePipeline,
  type PipelineStep,
} from './orchestrator-helpers.js';

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
  const strategyPath = pathResolver.rootResolve(input.strategy_path || 'knowledge/product/governance/orchestration-strategy.json');
  if (!safeExistsSync(strategyPath)) throw new Error(`Strategy not found: ${strategyPath}`);
  const config = JSON.parse(safeReadFile(strategyPath, { encoding: 'utf8' }) as string);
  for (const strategy of config.strategies) {
    await executePipeline(strategy.pipeline, strategy.params || {}, input.options);
  }
  return { status: 'reconciled' };
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = safeReadFile(pathResolver.rootResolve(argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
