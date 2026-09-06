import { isDirectEntry } from '@agent/core/direct-entry';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { parsePersistedPipelineStrategy, readJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { assertProjectTrustApproval } from '@agent/core/project-trust';
import {
  isBuiltinPipelineResource,
  requiresProjectTrust,
} from '@agent/core/trust-requiring-resources';
import { ensureDefaultOpPreflight } from '@agent/core/op-preflight-defaults';
import { runOpPreflight } from '@agent/core/op-preflight';
import * as path from 'node:path';
import { executePipeline, type PipelineStep } from './orchestrator-helpers.js';
import {
  currentProcessArgv,
  runActuatorCli,
  runActuatorCliEntryPoint,
} from '@agent/core/cli-utils';

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

function resolveStrategyPath(strategyPath: string | undefined): {
  absolute: string;
  relative: string;
} {
  const root = path.resolve(pathResolver.rootDir());
  const requested =
    strategyPath?.trim() || 'knowledge/product/governance/orchestration-strategy.json';
  const absolute = path.resolve(pathResolver.rootResolve(requested));
  const relative = path.relative(root, absolute).replaceAll(path.sep, '/');
  if (!relative || relative === '.' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('[ORCHESTRATOR_SCOPE] strategy_path must be inside the repository root');
  }

  let current = root;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try {
      if (safeLstat(current).isSymbolicLink()) {
        throw new Error(
          `[ORCHESTRATOR_SCOPE] strategy_path cannot traverse a symbolic link: ${relative}`
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('[ORCHESTRATOR_SCOPE]')) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Missing paths are reported by the normal strategy-not-found error.
        continue;
      }
      throw new Error(
        `[ORCHESTRATOR_SCOPE] strategy_path could not be inspected safely: ${relative}`
      );
    }
  }
  return { absolute, relative };
}

function assertStrategyTrust(input: OrchestratorAction, relativePath: string): void {
  if (!requiresProjectTrust(relativePath) || isBuiltinPipelineResource(relativePath)) return;
  const context = input.context || {};
  const approvalId =
    typeof context.project_trust_approval_id === 'string'
      ? context.project_trust_approval_id.trim()
      : '';
  if (approvalId) {
    assertProjectTrustApproval(approvalId, relativePath);
    return;
  }
  if (context.trust_resolved !== true) {
    throw new Error(
      `[TRUST_REQUIRED] project-local orchestrator strategy cannot be loaded before trust resolution: ${relativePath}`
    );
  }
}

async function handleAction(input: OrchestratorAction) {
  if (input.action === 'reconcile') {
    ensureDefaultOpPreflight();
    const preflight = await runOpPreflight({
      op: 'orchestrator:reconcile',
      params: {
        ...(input.strategy_path ? { strategy_path: input.strategy_path } : {}),
        ...(input.options ? { options: input.options } : {}),
      },
      context: input.context,
      source: 'actuator',
    });
    if (preflight.decision !== 'allow') {
      throw new Error(
        `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || 'Operation orchestrator:reconcile was not admitted.'}`
      );
    }
    return await performReconcile(input);
  }
  if (input.action !== 'pipeline') {
    throw new Error(`Unsupported orchestrator action: ${input.action}`);
  }
  return await executePipeline(input.steps || [], input.context || {}, input.options);
}

async function performReconcile(input: OrchestratorAction) {
  const resolved = resolveStrategyPath(input.strategy_path);
  assertStrategyTrust(input, resolved.relative);
  if (!safeExistsSync(resolved.absolute))
    throw new Error(`Strategy not found: ${resolved.absolute}`);
  const config = parsePersistedPipelineStrategy(
    readJson(resolved.absolute),
    'orchestrator strategy'
  );
  for (const strategy of config.strategies) {
    await executePipeline(strategy.pipeline, strategy.params || {}, input.options);
  }
  return { status: 'reconciled' };
}

const main = async () => {
  await runActuatorCli({
    name: 'orchestrator-actuator',
    args: currentProcessArgv(),
    handleAction,
  });
};

if (isDirectEntry(import.meta.url, 'libs/actuators/orchestrator-actuator/src/index.ts')) {
  void runActuatorCliEntryPoint(main, 'orchestrator-actuator');
}

export { handleAction };

export const actuator = defineCatalogBackedActuator({
  id: 'orchestrator-actuator',
  describeOps,
  handleAction: (input) => handleAction(input as Parameters<typeof handleAction>[0]),
});
import { defineCatalogBackedActuator } from '../../../core/actuator-sdk.js';
import { describeOps } from './op-catalog.js';
