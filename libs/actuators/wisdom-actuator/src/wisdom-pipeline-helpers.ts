import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  pathResolver,
  resolveVars,
  evaluateCondition,
  getPathValue,
  retry,
  buildGovernedRetryOptions,
  classifyError,
  derivePipelineStatus,
  executeAdfSteps,
  getReasoningBackend,
  getVoiceBridge,
  getSpeechToTextBridge,
  saveRequirementsDraft,
  evaluateRequirementsCompletenessGate,
  evaluateCustomerSignoffGate,
  saveDesignSpec,
  saveTestPlan,
  saveTaskPlan,
  readRequirementsDraft,
  readDesignSpec,
  readTestPlan,
  readTaskPlan,
  evaluateArchitectureReadyGate,
  evaluateQaReadyGate,
  evaluateTaskPlanReadyGate,
  consumeTenantBudget,
  TenantRateLimitExceededError,
  findRelevantDistilledKnowledge,
  formatDistilledKnowledgeSummary,
  rebuildPublicHistorySearchIndexFromLocalSources,
  searchHistory,
  recordActionItem,
  listActionItems,
  listOthersPending,
  listOperatorSelfPending,
  appendReminder,
  updateActionItemStatus,
  nextActionItemId,
  matchRestrictedAction,
  loadMeetingFacilitatorPolicy,
  registerPresentationPreferenceProfile,
  type ActionItem,
  type ActionItemAssignee,
  type ActionItemAssigneeKind,
  type ActionItemModality,
  type ActionItemReviewState,
  type ActionItemProvenance,
  type MeetingFacilitatorPolicy,
  type PresentationPreferenceProfile,
} from '@agent/core';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { dispatchDecisionOp } from './decision-ops.js';
import { createWisdomDispatcher } from './wisdom-dispatcher.js';
import { getWisdomOperationSpec } from './op-catalog.js';
import { forwardWisdomBoundaryOperation } from './compatibility/cross-actuator-forwarders.js';
import type { WisdomContext } from './contracts/wisdom-context.js';
import type { WisdomReceipt } from './contracts/wisdom-result.js';
import { validateWisdomRequest } from './contracts/wisdom-request.js';

const WISDOM_MANIFEST_PATH = pathResolver.rootResolve(
  'libs/actuators/wisdom-actuator/manifest.json'
);
const KNOWLEDGE_PACKAGE_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const KNOWLEDGE_TIER_PATTERN = /^(personal|confidential|public)$/;
const DEFAULT_WISDOM_RETRY = {
  maxRetries: 2,
  initialDelayMs: 250,
  maxDelayMs: 2000,
  factor: 2,
  jitter: true,
};

const RECONCILE_ALLOWED_OPS = new Set([
  'history_search',
  'knowledge_search',
  'query',
  'distill',
  'inject_prior_knowledge',
  'knowledge_inject',
  'knowledge_export',
  'knowledge_import',
]);

function assertWisdomReconcileSteps(steps: PipelineStep[]): void {
  for (const step of steps) {
    if (step.type === 'control') {
      const nested =
        step.op === 'if'
          ? [
              ...((step.params.then as PipelineStep[] | undefined) || []),
              ...((step.params.else as PipelineStep[] | undefined) || []),
            ]
          : (step.params.pipeline as PipelineStep[] | undefined) || [];
      assertWisdomReconcileSteps(nested);
      continue;
    }
    if (!RECONCILE_ALLOWED_OPS.has(step.op)) {
      throw new Error(
        `[RECONCILE_SCOPE_VIOLATION] reconcile cannot execute non-knowledge op: ${step.type}:${step.op}`
      );
    }
  }
}

function buildRetryOptions() {
  return buildGovernedRetryOptions({
    manifestPath: WISDOM_MANIFEST_PATH,
    defaults: DEFAULT_WISDOM_RETRY,
    fallbackCategories: ['resource_unavailable', 'timeout'],
  });
}

export async function runWithOperationRetry<T>(op: string, task: () => Promise<T>): Promise<T> {
  const idempotency = getWisdomOperationSpec(op)?.idempotency;
  if (idempotency !== 'read' && idempotency !== 'idempotent_write') return task();
  return retry(task, buildRetryOptions());
}

function normalizeKnowledgeTier(value: unknown): 'personal' | 'confidential' | 'public' {
  const tier = String(value || 'confidential')
    .trim()
    .toLowerCase();
  if (!KNOWLEDGE_TIER_PATTERN.test(tier)) {
    throw new Error(`Invalid knowledge import tier: ${value}`);
  }
  return tier as 'personal' | 'confidential' | 'public';
}

function normalizeKnowledgePackageAgentId(value: unknown): string {
  const agentId = String(value || '').trim();
  if (!KNOWLEDGE_PACKAGE_AGENT_ID_PATTERN.test(agentId)) {
    throw new Error(`Invalid knowledge package origin_agent_id: ${value}`);
  }
  return agentId;
}

export interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: Record<string, unknown>;
}

export interface WisdomDirectAction {
  action:
    | 'knowledge_search'
    | 'history_search'
    | 'knowledge_inject'
    | 'knowledge_export'
    | 'knowledge_import';
  params: Record<string, unknown>;
}

export interface WisdomAction {
  action: 'pipeline' | 'reconcile' | WisdomDirectAction['action'];
  params?: Record<string, unknown>;
  steps?: PipelineStep[];
  strategy_path?: string;
  context?: WisdomContext;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
    compatibility_mode?: boolean;
  };
}

export async function handleAction(input: WisdomAction) {
  validateWisdomRequest(input);
  if (input.action === 'reconcile') {
    return await performReconcile(input);
  }
  if (input.action === 'pipeline') {
    return await executePipeline(input.steps || [], input.context || {}, input.options);
  }
  const spec = getWisdomOperationSpec(input.action);
  if (!spec) throw new Error(`[UNKNOWN_OP] Unknown direct wisdom action: ${input.action}`);
  return await executePipeline(
    [{ type: spec.kind, op: input.action, params: input.params || {} }],
    {},
    input.options
  );
}

// AR-01 Task 2: hand-rolled loop replaced by the canonical engine
// (executeAdfSteps). Nested control failures now propagate instead of being
// silently absorbed (AR-06 no-silent-failure).
export async function executePipeline(
  steps: PipelineStep[],
  initialCtx: WisdomContext = {},
  options: WisdomAction['options'] = {}
) {
  const MAX_STEPS = options.max_steps || 1000;
  const TIMEOUT = options.timeout_ms || 60000;
  const contextPath =
    typeof initialCtx.context_path === 'string' ? initialCtx.context_path : undefined;

  let ctx: WisdomContext = { ...initialCtx, today: new Date().toISOString().split('T')[0] };
  const receipts: WisdomReceipt[] = [];
  const dispatcher = createWisdomDispatcher(
    {
      capture: (op, params, currentCtx) =>
        opCapture(op, params, currentCtx, options.compatibility_mode),
      transform: (op, params, currentCtx) =>
        opTransform(op, params, currentCtx, options.compatibility_mode),
      apply: (op, params, currentCtx) =>
        opApply(op, params, currentCtx, options.compatibility_mode),
    },
    {
      fallback: async (_kind, op, params, currentCtx) => {
        const decision = await dispatchDecisionOp(op, params, currentCtx, {
          compatibilityMode: options.compatibility_mode,
        });
        if (!decision.handled) throw new Error(`[UNKNOWN_OP] Unknown wisdom operation: ${op}`);
        return decision.ctx;
      },
    }
  );

  if (contextPath && safeExistsSync(pathResolver.rootResolve(contextPath))) {
    const saved = await retry(
      async () =>
        JSON.parse(
          safeReadFile(pathResolver.rootResolve(contextPath), {
            encoding: 'utf8',
          }) as string
        ),
      buildRetryOptions()
    );
    ctx = { ...ctx, ...saved };
  }

  const result = await executeAdfSteps(
    steps as Parameters<typeof executeAdfSteps>[0],
    ctx,
    { maxSteps: MAX_STEPS, timeoutMs: TIMEOUT },
    {
      capture: async (op, params, currentCtx) => {
        const result = await dispatcher.dispatch('capture', op, params, currentCtx);
        receipts.push(result.receipt);
        return result.context;
      },
      transform: async (op, params, currentCtx) => {
        const result = await dispatcher.dispatch('transform', op, params, currentCtx);
        receipts.push(result.receipt);
        return result.context;
      },
      apply: async (op, params, currentCtx) => {
        const result = await dispatcher.dispatch('apply', op, params, currentCtx);
        receipts.push(result.receipt);
        return result.context;
      },
      control: opControl,
    }
  );
  ctx = result.context;

  if (contextPath) {
    await retry(async () => {
      safeWriteFile(pathResolver.rootResolve(contextPath), JSON.stringify(ctx, null, 2));
      return undefined;
    }, buildRetryOptions());
  }

  return { ...result, receipts };
}

async function opControl(
  op: string,
  params: any,
  ctx: any,
  runSteps: (steps: any[], seedCtx?: any) => Promise<any>,
  _resolve: (value: any) => any
) {
  const runNested = async (steps: any[], seedCtx: any) => {
    const res = await runSteps(steps, seedCtx);
    if (res.status === 'failed') {
      throw new Error(
        res.results.find((entry: any) => entry.status === 'failed')?.error ||
          'nested pipeline failed'
      );
    }
    return res.context;
  };

  switch (op) {
    case 'if':
      if (evaluateCondition(params.condition, ctx)) {
        return await runNested(params.then, ctx);
      } else if (params.else) {
        return await runNested(params.else, ctx);
      }
      return ctx;

    case 'while': {
      let iterations = 0;
      const maxIter = params.max_iterations || 100;
      while (evaluateCondition(params.condition, ctx) && iterations < maxIter) {
        ctx = await runNested(params.pipeline, ctx);
        iterations++;
      }
      return ctx;
    }

    default:
      throw new Error(`[UNKNOWN_OP] Unknown op: ${op}`);
  }
}

async function opCapture(
  op: string,
  params: any,
  ctx: any,
  _compatibilityMode = false
): Promise<WisdomContext | undefined> {
  const forwarded = await forwardWisdomBoundaryOperation(op, params, ctx, {
    compatibilityMode: _compatibilityMode,
    defaultExportKey: 'last_capture',
  });
  if (forwarded) return forwarded;

  switch (op) {
    case 'history_search': {
      if (params.refresh_public_index === true) {
        rebuildPublicHistorySearchIndexFromLocalSources();
      }
      const query = params.query === undefined ? '' : resolveVars(params.query, ctx);
      const sessionId =
        params.session_id === undefined ? undefined : resolveVars(params.session_id, ctx);
      const report = searchHistory({
        query: String(query || ''),
        mode: params.mode,
        sessionId: sessionId ? String(sessionId) : undefined,
        // This op is intentionally bound to the shared public index. A
        // tier-specific collector must expose a separate governed entrypoint.
        tiers: ['public'],
        maxResults: params.max_results,
        includeScheduled: params.include_scheduled,
        includeSubagent: false,
      });
      return { ...ctx, [params.export_as || 'history_search_results']: report };
    }
    case 'knowledge_search': {
      const { buildScopedIndex, queryKnowledgeHybrid, DEFAULT_SCOPE } = await import('@agent/core');
      const securityScope =
        ctx.security_scope && typeof ctx.security_scope === 'object'
          ? (ctx.security_scope as Record<string, unknown>)
          : undefined;
      const requestedTier = params.tier ? normalizeKnowledgeTier(params.tier) : undefined;
      const readTiers = Array.isArray(securityScope?.read_tiers)
        ? securityScope.read_tiers.filter((tier): tier is 'personal' | 'confidential' | 'public' =>
            KNOWLEDGE_TIER_PATTERN.test(String(tier))
          )
        : requestedTier
          ? [requestedTier]
          : DEFAULT_SCOPE.tiers;
      if (requestedTier && !readTiers.includes(requestedTier)) {
        throw new Error(
          `[KNOWLEDGE_SCOPE_VIOLATION] requested tier ${requestedTier} is outside the read scope`
        );
      }
      if (readTiers.some((tier) => tier !== 'public') && !securityScope?.tenant_id) {
        throw new Error(
          '[KNOWLEDGE_SCOPE_REQUIRED] tenant_id is required for non-public knowledge search'
        );
      }
      const scope = {
        tiers: readTiers,
        ...(securityScope?.tenant_id || ctx.tenant_id
          ? { customerId: String(securityScope?.tenant_id || ctx.tenant_id) }
          : {}),
      };
      const scopeKey = JSON.stringify(scope);
      let index = ctx._knowledgeIndex;
      if (!index || ctx._knowledgeIndexScopeKey !== scopeKey) {
        index = await buildScopedIndex(scope);
      }
      const query = String(resolveVars(params.query ?? '', ctx));
      const results = await queryKnowledgeHybrid(index, query, {
        maxResults: Number(params.limit || params.max_results || 5),
        scope:
          securityScope?.mission_id || securityScope?.project_id
            ? String(securityScope.mission_id || securityScope.project_id)
            : undefined,
      });
      const normalized = results.map((entry) => ({
        source_ref: entry.source,
        tier: entry.tier || 'public',
        scope: {
          ...(securityScope?.tenant_id ? { tenant_id: securityScope.tenant_id } : {}),
          ...(securityScope?.project_id ? { project_id: securityScope.project_id } : {}),
          ...(securityScope?.mission_id ? { mission_id: securityScope.mission_id } : {}),
        },
        title: entry.topic,
        tags: entry.tags || [],
        score: entry.confidence,
        retrieval_reason: entry.embeddingBackend
          ? 'scoped hybrid lexical-semantic retrieval'
          : 'scoped lexical retrieval fallback',
        provenance: {
          source_ref: entry.source,
          matched_chunk_index: entry.matchedChunkIndex,
          embedding_backend: entry.embeddingBackend,
          doc_authority: entry.doc_authority,
          knowledge_scope: entry.scope,
        },
        hint: entry.hint,
      }));
      return {
        ...ctx,
        _knowledgeIndex: index,
        _knowledgeIndexScopeKey: scopeKey,
        [params.export_as || 'found_knowledge']: normalized,
      };
    }
    case 'query': {
      const { buildScopedIndex, queryKnowledgeHybrid, DEFAULT_SCOPE } = await import('@agent/core');
      const scope = ctx._knowledge_scope ?? DEFAULT_SCOPE;
      const scopeKey = JSON.stringify(scope);
      if (!ctx._knowledgeIndex || ctx._knowledgeIndexScopeKey !== scopeKey) {
        ctx._knowledgeIndex = await buildScopedIndex(scope);
        ctx._knowledgeIndexScopeKey = scopeKey;
      }
      const hints = await queryKnowledgeHybrid(
        ctx._knowledgeIndex,
        resolveVars(params.topic, ctx),
        {
          actuator: params.actuator,
          op: params.op,
          maxResults: params.max_results || 5,
        }
      );
      ctx = { ...ctx, [params.export_as || 'last_hints']: hints };
      return ctx;
    }
    default:
      return undefined;
  }
}

async function opTransform(
  op: string,
  params: any,
  ctx: any,
  compatibilityMode = false
): Promise<WisdomContext> {
  switch (op) {
    case 'regex_extract': {
      const input = String(ctx[params.from || 'last_capture'] || '');
      const regex = new RegExp(params.pattern, params.count_all ? 'gm' : 'm');
      if (params.count_all) {
        return { ...ctx, [params.export_as]: (input.match(regex) || []).length };
      }
      const match = input.match(regex);
      return { ...ctx, [params.export_as]: match ? match[1] || match[0] : null };
    }
    case 'regex_replace': {
      const input = String(ctx[params.from || 'last_capture'] || '');
      return {
        ...ctx,
        [params.export_as || 'last_transform']: input.replace(
          new RegExp(params.pattern, 'g'),
          resolveVars(params.template, ctx)
        ),
      };
    }
    case 'yaml_update': {
      const content = String(ctx[params.from || 'last_capture'] || '');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/m);
      if (!fmMatch) return ctx;
      const fm = yaml.load(fmMatch[1]) as any;
      fm[params.field] = resolveVars(params.value, ctx);
      const newFm = yaml.dump(fm, { lineWidth: -1 }).trim();
      return {
        ...ctx,
        [params.export_as || 'last_transform']: content.replace(
          /^---\n[\s\S]*?\n---/m,
          `---\n${newFm}\n---`
        ),
      };
    }
    case 'json_query': {
      const data = ctx[params.from || 'last_capture_data'];
      const result = getPathValue(data, params.path);
      return { ...ctx, [params.export_as]: result };
    }
    case 'array_count': {
      const list = ctx[params.from] || [];
      const count = list.filter((item: any) => {
        return !params.where || Object.entries(params.where).every(([k, v]) => item[k] === v);
      }).length;
      return { ...ctx, [params.export_as]: count };
    }
    default:
      return undefined;
  }
}

async function opApply(
  op: string,
  params: any,
  ctx: any,
  compatibilityMode = false
): Promise<WisdomContext | undefined> {
  const forwarded = await forwardWisdomBoundaryOperation(op, params, ctx, {
    compatibilityMode,
    defaultExportKey: 'last_apply_result',
  });
  if (forwarded) return forwarded;

  switch (op) {
    case 'knowledge_inject':
      await runWithOperationRetry('knowledge_inject', async () => {
        const kPath = resolveVars(params.knowledge_path, ctx);
        const missionId = resolveVars(params.mission_id, ctx);
        const missionPath = (pathResolver as any).findMissionPath(missionId);
        if (!missionPath) throw new Error(`Mission ${missionId} not found.`);

        const sourcePath = pathResolver.knowledge(kPath);
        const fileName = path.basename(sourcePath);
        const targetPath = path.join(missionPath, `evidence/injected_${fileName}`);

        if (safeExistsSync(sourcePath)) {
          const data = safeReadFile(sourcePath, { encoding: 'utf8' }) as string;
          safeWriteFile(targetPath, data);
          logger.success(`💉 [Wisdom] Injected knowledge ${kPath} into mission ${missionId}`);
        } else {
          throw new Error(`Knowledge source not found: ${sourcePath}`);
        }
      });
      break;
    case 'log':
      logger.info(`[WISDOM_LOG] ${resolveVars(params.message || 'Action completed', ctx)}`);
      break;
    case 'knowledge_export':
      await runWithOperationRetry('knowledge_export', async () => {
        const sourceFile = pathResolver.knowledge(resolveVars(params.path, ctx));
        if (!safeExistsSync(sourceFile))
          throw new Error(`Knowledge source not found: ${sourceFile}`);

        const agentId = normalizeKnowledgePackageAgentId(
          params.origin_agent_id || ctx.agent_id || ctx.execution_context?.agent_id
        );
        const originTenantId = String(
          params.origin_tenant_id || ctx.tenant_id || ctx.execution_context?.tenant_id || ''
        ).trim();
        if (!originTenantId)
          throw new Error('[KNOWLEDGE_ORIGIN_SCOPE_REQUIRED] origin_tenant_id is required');
        const sourceTier = normalizeKnowledgeTier(
          params.source_tier || ctx.knowledge_tier || 'confidential'
        );
        const rawData = safeReadFile(sourceFile, { encoding: 'utf8' }) as string;
        const { createHash } = await import('node:crypto');
        const hash = createHash('sha256').update(rawData).digest('hex');
        const packageId = String(params.package_id || `KKP-${hash.slice(0, 16)}`);

        const kkp = {
          metadata: {
            package_version: '1.0.0',
            package_id: packageId,
            origin_agent_id: agentId,
            origin_tenant_id: originTenantId,
            origin_project_id: String(params.origin_project_id || ctx.project_id || ''),
            source_tier: sourceTier,
            requested_target_tier: normalizeKnowledgeTier(
              params.requested_target_tier || params.visibility || sourceTier
            ),
            content_hash: hash,
            created_at: new Date().toISOString(),
            provenance: [resolveVars(params.path, ctx)],
            trust_status: 'unverified',
            signature: { status: 'absent' },
            payload_encoding: 'utf8',
          },
          content: {
            path: resolveVars(params.path, ctx),
            raw_data: rawData,
          },
        };

        const outPath = pathResolver.rootResolve(
          resolveVars(
            params.output_path ||
              pathResolver.sharedExports(`wisdom/${kkp.metadata.package_id}.kkp`),
            ctx
          )
        );
        safeWriteFile(outPath, JSON.stringify(kkp, null, 2));
        logger.success(`📦 [Wisdom] Knowledge exported to ${outPath}`);
      });
      break;

    case 'knowledge_import':
      await runWithOperationRetry('knowledge_import', async () => {
        const pkgPath = pathResolver.rootResolve(resolveVars(params.package_path, ctx));
        if (!safeExistsSync(pkgPath)) throw new Error(`Package not found: ${pkgPath}`);

        const pkg = JSON.parse(safeReadFile(pkgPath, { encoding: 'utf8' }) as string);
        const { createHash: vHash } = await import('node:crypto');
        const rawData = pkg?.content?.raw_data;
        if (typeof rawData !== 'string')
          throw new Error('[KNOWLEDGE_PACKAGE_INVALID] content.raw_data is required');
        const actualHash = vHash('sha256').update(rawData).digest('hex');
        const expectedHash = pkg?.metadata?.content_hash || pkg?.metadata?.hash;

        if (actualHash !== expectedHash) {
          throw new Error(
            `CRITICAL: Knowledge Package integrity check failed. Expected: ${expectedHash}, Got: ${actualHash}`
          );
        }

        const targetTier = normalizeKnowledgeTier(params.tier);
        const originAgentId = normalizeKnowledgePackageAgentId(pkg?.metadata?.origin_agent_id);
        const originTenantId = String(pkg?.metadata?.origin_tenant_id || '').trim();
        if (!originTenantId)
          throw new Error('[KNOWLEDGE_ORIGIN_SCOPE_REQUIRED] origin_tenant_id is required');
        const sourceTier = normalizeKnowledgeTier(
          pkg?.metadata?.source_tier || pkg?.metadata?.visibility
        );
        if (sourceTier !== 'public' && targetTier === 'public' && !params.promotion_approval_id) {
          throw new Error(
            '[KNOWLEDGE_PROMOTION_APPROVAL_REQUIRED] promotion approval is required for public import'
          );
        }
        const importDir = pathResolver.knowledge(`${targetTier}/external/${originAgentId}`);
        if (!safeExistsSync(importDir)) safeMkdir(importDir, { recursive: true });

        const targetFile = path.join(importDir, path.basename(pkg.content.path));
        safeWriteFile(targetFile, rawData);

        logger.success(`📥 [Wisdom] Imported knowledge from ${originAgentId} to ${targetFile}`);
      });
      break;

    default:
      return undefined;
  }
}

export async function performReconcile(input: WisdomAction) {
  const strategyPath = pathResolver.knowledge(
    input.strategy_path || 'governance/wisdom-reconcile-strategy.json'
  );
  if (!safeExistsSync(strategyPath)) throw new Error(`Strategy not found: ${strategyPath}`);
  const config = (await retry(
    async () => JSON.parse(safeReadFile(strategyPath, { encoding: 'utf8' }) as string),
    buildRetryOptions()
  )) as {
    strategies: Array<{
      for_each?: { op: string; params: Record<string, unknown> };
      pipeline: PipelineStep[];
      params?: WisdomContext;
    }>;
  };
  for (const strategy of config.strategies) {
    if (strategy.for_each) {
      if (!RECONCILE_ALLOWED_OPS.has(strategy.for_each.op)) {
        throw new Error(
          `[RECONCILE_SCOPE_VIOLATION] reconcile cannot collect with op: ${strategy.for_each.op}`
        );
      }
      assertWisdomReconcileSteps(strategy.pipeline);
      const listCtx = await opCapture(strategy.for_each.op, strategy.for_each.params, {});
      const exportKey = String(strategy.for_each.params.export_as || '');
      const listValue = listCtx[exportKey];
      const list = Array.isArray(listValue) ? listValue : [];
      for (const item of list) {
        await executePipeline(strategy.pipeline, { ...strategy.params, item }, input.options);
      }
    } else {
      assertWisdomReconcileSteps(strategy.pipeline);
      await executePipeline(strategy.pipeline, strategy.params || {}, input.options);
    }
  }
  return { status: 'reconciled' };
}
