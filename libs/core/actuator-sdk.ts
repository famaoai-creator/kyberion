import { buildUnknownActuatorOpError, type PipelineStepType } from './actuator-op-registry.js';
import { createAjv } from './foundation/ajv.js';
import { ensureDefaultOpPreflight } from './op-preflight-defaults.js';
import { runOpPreflight } from './op-preflight.js';
import { resolvePipelineInputPlaceholders } from './pipeline-input-contract.js';
import {
  executeAdfSteps,
  type AdfRunOptions,
  type AdfRunResult,
  type AdfStep,
  type AdfStepHandlers,
  type AdfStepHooks,
} from './adf-engine.js';
import {
  requireSandboxEnforcement,
  withSandboxPolicy,
  type SandboxPolicy,
} from './sandbox-policy.js';
import {
  assertExecutionBounds,
  createExecutionBoundsState,
  DEFAULT_MAX_PIPELINE_STEPS,
  DEFAULT_PIPELINE_TIMEOUT_MS,
} from './execution-bounds.js';

const actuatorContractAjv = createAjv();

export type ActuatorResultStatus = 'succeeded' | 'failed' | 'denied';

export interface ActuatorResult<Output = unknown> {
  ok: boolean;
  status: ActuatorResultStatus;
  actuator_id: string;
  op: string;
  output?: Output;
  error?: string;
}

export interface ActuatorOpDescription {
  op: string;
  kind: PipelineStepType;
  input_schema?: unknown;
  examples?: Array<Record<string, unknown>>;
  owner?: string;
  idempotency?: string;
  execution_kind?: string;
  deprecated?: boolean;
  canonical_op?: string;
  forward_to?: {
    actuator: string;
    op: string;
  };
}

export interface ActuatorPipelineStep<Params = Record<string, unknown>> {
  type?: string;
  op: string;
  params?: Params;
  /** Optional step-level approval metadata projected by a caller. */
  approval_required?: boolean;
}

export interface RunActuatorPipelineOptions<
  Params extends object,
  Context extends Record<string, unknown>,
> {
  actuatorId: string;
  steps: readonly ActuatorPipelineStep<Params>[];
  context: Context;
  /** Maximum number of steps admitted by this in-process pipeline. */
  maxSteps?: number;
  /** Wall-clock limit for this in-process pipeline. */
  timeoutMs?: number;
  /** Optional resolved sandbox policy for every domain handler invocation. */
  sandboxPolicy?: SandboxPolicy;
  /** Trusted caller-side presence signal for approval-gated steps. */
  hasHuman?: boolean;
  /** Trusted caller-side resolver for a bound approval decision. */
  approvalGranted?: (
    step: ActuatorPipelineStep<Params>,
    params: Params,
    context: Context
  ) => boolean | Promise<boolean>;
  /** Resolve pipeline placeholders before the operation preflight boundary. */
  resolveParams?: (
    params: Params,
    context: Context,
    step: ActuatorPipelineStep<Params>
  ) => Params | Promise<Params>;
  execute: (
    op: string,
    params: Params,
    context: Context,
    step: ActuatorPipelineStep<Params>
  ) => Context | Promise<Context>;
}

/**
 * Run a domain actuator's in-process step sequence through the shared
 * preflight boundary. The handler remains domain-specific, but ordering and
 * fail-closed admission are identical for every actuator that uses this
 * helper.
 */
export async function runActuatorPipeline<
  Params extends object,
  Context extends Record<string, unknown>,
>(options: RunActuatorPipelineOptions<Params, Context>): Promise<Context> {
  if (options.sandboxPolicy) requireSandboxEnforcement(options.sandboxPolicy);
  const run = async (): Promise<Context> => {
    let context = options.context;
    const bounds = createExecutionBoundsState();
    for (const step of options.steps) {
      bounds.stepCount += 1;
      assertExecutionBounds(bounds, {
        maxSteps: options.maxSteps ?? DEFAULT_MAX_PIPELINE_STEPS,
        timeoutMs: options.timeoutMs ?? DEFAULT_PIPELINE_TIMEOUT_MS,
      });
      const rawParams = (step.params ?? {}) as Params;
      const resolvedParams = options.resolveParams
        ? await options.resolveParams(rawParams, context, step)
        : rawParams;
      const resolvedParamsRecord = resolvedParams as Record<string, unknown>;
      ensureDefaultOpPreflight();
      const preflight = await runOpPreflight({
        op: `${options.actuatorId}:${step.op}`,
        params: resolvedParamsRecord,
        context,
        source: 'actuator',
        requiresApproval:
          step.approval_required === true ||
          resolvedParamsRecord._approval_required === true ||
          context._approval_required === true,
        approvalGranted: options.approvalGranted
          ? await options.approvalGranted(step, resolvedParams, context)
          : false,
        ...(options.hasHuman !== undefined ? { hasHuman: options.hasHuman } : {}),
      });
      if (preflight.decision !== 'allow') {
        throw new Error(
          `[OP_PREFLIGHT_${preflight.decision.toUpperCase()}] ${preflight.reason || `Operation ${options.actuatorId}:${step.op} was not admitted.`}`
        );
      }
      context = await options.execute(step.op, preflight.input as Params, context, step);
    }
    return context;
  };
  return options.sandboxPolicy ? withSandboxPolicy(options.sandboxPolicy, run) : run();
}

export interface RunAdfActuatorPipelineOptions<Context extends Record<string, unknown>> {
  actuatorId: string;
  steps: readonly AdfStep[];
  context: Context;
  /** All engine controls remain available; the SDK owns the runner label. */
  options?: Omit<AdfRunOptions, 'label'>;
  /** Optional resolved sandbox policy for all nested actuator handlers. */
  sandboxPolicy?: SandboxPolicy;
  handlers: AdfStepHandlers<Context>;
  hooks?: AdfStepHooks<Context>;
}

/**
 * Shared entry for actuator runners whose domain logic is already expressed
 * as ADF handlers. The SDK owns engine options and result accounting while
 * the actuator retains only its domain handlers and context persistence.
 */
export async function runAdfActuatorPipeline<Context extends Record<string, unknown>>(
  options: RunAdfActuatorPipelineOptions<Context>
): Promise<AdfRunResult<Context>> {
  return executeAdfSteps(
    [...options.steps],
    options.context,
    {
      maxSteps: options.options?.maxSteps ?? DEFAULT_MAX_PIPELINE_STEPS,
      timeoutMs: options.options?.timeoutMs ?? DEFAULT_PIPELINE_TIMEOUT_MS,
      ...options.options,
      ...(options.sandboxPolicy ? { sandboxPolicy: options.sandboxPolicy } : {}),
      label: `[${options.actuatorId}]`,
    },
    options.handlers,
    options.hooks
  );
}

export interface ActuatorStepSequenceResult<Context extends Record<string, unknown>> {
  status: 'succeeded' | 'failed';
  results: Array<{ op: string; status: 'success' | 'failed'; error?: string }>;
  context: Context;
}

export interface RunActuatorStepSequenceOptions<
  Params extends object,
  Context extends Record<string, unknown>,
> extends Omit<RunActuatorPipelineOptions<Params, Context>, 'steps' | 'context'> {
  steps: readonly ActuatorPipelineStep<Params>[];
  context: Context;
  /** Maximum number of domain steps admitted for this sequence. */
  maxSteps?: number;
  onStepStart?: (step: ActuatorPipelineStep<Params>) => void | Promise<void>;
  onStepError?: (step: ActuatorPipelineStep<Params>, error: unknown) => void | Promise<void>;
}

/**
 * Run a domain actuator's ordered sequence through the same per-step
 * preflight boundary, stopping on the first failure and returning a stable
 * result envelope. Domain handlers remain responsible for operation logic;
 * sequence accounting is intentionally shared here.
 */
export async function runActuatorStepSequence<
  Params extends object,
  Context extends Record<string, unknown>,
>(
  options: RunActuatorStepSequenceOptions<Params, Context>
): Promise<ActuatorStepSequenceResult<Context>> {
  const { steps, maxSteps, onStepStart, onStepError, ...pipelineOptions } = options;
  const limit = maxSteps ?? DEFAULT_MAX_PIPELINE_STEPS;
  if (steps.length > limit) {
    throw new Error(`[SAFETY_LIMIT] Exceeded maximum pipeline steps (${limit})`);
  }

  let context = options.context;
  const bounds = createExecutionBoundsState();
  const results: ActuatorStepSequenceResult<Context>['results'] = [];
  for (const step of steps) {
    bounds.stepCount += 1;
    assertExecutionBounds(bounds, {
      maxSteps: limit,
      timeoutMs: pipelineOptions.timeoutMs ?? DEFAULT_PIPELINE_TIMEOUT_MS,
    });
    await onStepStart?.(step);
    try {
      context = await runActuatorPipeline({
        ...pipelineOptions,
        steps: [step],
        context,
      });
      results.push({ op: step.op, status: 'success' });
    } catch (error) {
      await onStepError?.(step, error);
      results.push({
        op: step.op,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }

  return {
    status: results.some((result) => result.status === 'failed') ? 'failed' : 'succeeded',
    results,
    context,
  };
}

/**
 * Explicit transitional operations whose deployed pipelines still carry an
 * older envelope. This is the one allowlist shared by runtime dispatch,
 * discovery generation, and pipeline schema coverage; it must not be inferred
 * from implementation field usage.
 */
const LEGACY_OPEN_OPERATION_IDS = new Set([
  'browser:click_ref',
  'browser:close_session',
  'browser:fill_ref',
  'browser:import_session_handoff',
  'media:apply_pattern',
  'media:document_diagram_asset_from_brief',
  'media:document_digest',
  'media:pptx_render',
  'media:pptx_slide_text',
  'media:save_brand_to_confidential',
  'media:write_file',
  'meeting:join',
  'meeting:leave',
  'meeting:listen',
  'meeting:run_action_item_reminder_sweep',
  'meeting:status',
  'meeting:track_pending_action_items',
  'modeling:extract_requirements',
  'network:fetch',
  'orchestrator:run_execution_plan_set',
  'service:cli',
  'system:if',
  'system:native_tts_speak',
  'system:probe',
  'system:screenshot',
  'video-composition:await_video_composition_job',
  'voice:collect_and_register_voice_profile',
  'voice:generate_voice',
  'voice:health',
  'voice:list_audio_routes',
  'voice:probe_audio_route',
  'voice:record_verify_repair_voice_sample',
  'voice:record_voice_sample',
  'voice:speak_local',
  'voice:verify_tts_loopback',
  'wisdom:capture_intuition',
  'wisdom:compute_readiness_matrix',
  'wisdom:curate_background_review',
  'wisdom:distill',
  'wisdom:emit_dissent_log',
  'wisdom:extract_dissent_signals',
  'wisdom:knowledge_inject',
  'wisdom:perspective_fanout',
  'wisdom:reasoning',
  'wisdom:recommend',
  'wisdom:render_hypothesis_report',
  'wisdom:simulate_all',
  'wisdom:synthesize_counterparty_persona',
  'wisdom:typed_cross_critique',
]);

export function isLegacyOpenActuatorOperation(scope: string, op: string): boolean {
  return LEGACY_OPEN_OPERATION_IDS.has(`${scope.replace(/-actuator$/u, '')}:${op}`);
}

/**
 * Transitional contract for an operation whose domain fields have not been
 * typed yet. The scope/op/kind identity keeps discovery entries distinct and
 * makes the remaining migration visible to contract coverage checks.
 */
export function buildOpenActuatorInputContract(
  scope: string,
  op: string,
  kind: PipelineStepType
): { input_schema: Record<string, unknown>; examples: Array<Record<string, unknown>> } {
  const identity = `${scope}:${op}`;
  return {
    input_schema: {
      type: 'object',
      title: identity,
      description: `Open legacy parameter contract for ${identity} (${kind}); replace with typed fields during operation migration.`,
      additionalProperties: true,
      'x-kyberion-contract': 'inferred-legacy',
    },
    examples: [{}],
  };
}

/** Complete an op-catalog entry at the catalog boundary, before generation. */
export function withCatalogInputContract<
  T extends {
    op: string;
    kind: PipelineStepType;
    input_schema?: unknown;
    examples?: Array<Record<string, unknown>>;
  },
>(scope: string, op: string, kind: PipelineStepType, description: T): T {
  if (description.input_schema !== undefined && !isLegacyOpenActuatorOperation(scope, op)) {
    return description;
  }
  return {
    ...description,
    ...buildOpenActuatorInputContract(scope, op, kind),
  };
}

export interface ActuatorOpDefinition<Input = unknown, Output = unknown> {
  kind: PipelineStepType;
  input_schema?: unknown;
  validateInput?: (value: unknown) => Input;
  handler: (input: Input, context: Record<string, unknown>) => Output | Promise<Output>;
}

export interface ActuatorDefinition<
  Ops extends Record<string, ActuatorOpDefinition> = Record<string, ActuatorOpDefinition>,
> {
  readonly id: string;
  readonly ops: Ops;
  describeOps(): ActuatorOpDescription[];
  dispatch(op: string, input: unknown, context?: Record<string, unknown>): Promise<ActuatorResult>;
}

/**
 * Pipeline execution attaches these governed, non-user fields to every
 * operation so routing/facets can survive the actuator boundary. They are
 * accepted by runtime validation without weakening the authored operation
 * contract for any other top-level key.
 */
const PIPELINE_EXECUTION_METADATA_PROPERTIES: Record<string, unknown> = {
  _facets: {},
  _reasoning_policy: {},
  _step_id: {},
};

export type LegacyPipelineActionHandler = (input: {
  action: 'pipeline';
  steps: Array<{ type: string; op: string; params: Record<string, unknown> }>;
  context: Record<string, unknown>;
  options?: unknown;
  pipelineTrace?: unknown;
}) => Promise<unknown> | unknown;

/** Define the one runtime ABI shared by generated and hand-written actuators. */
export function defineActuator<Ops extends Record<string, ActuatorOpDefinition>>(options: {
  id: string;
  ops: Ops;
}): ActuatorDefinition<Ops> {
  const id = options.id.trim();
  if (!id) throw new Error('actuator id is required');
  const descriptions = Object.entries(options.ops).map(([op, definition]) => ({
    op,
    kind: definition.kind,
    ...(definition.input_schema !== undefined ? { input_schema: definition.input_schema } : {}),
  }));
  return {
    id,
    ops: options.ops,
    describeOps: () => descriptions.map((description) => ({ ...description })),
    async dispatch(op, input, context = {}) {
      const definition = options.ops[op];
      if (!definition) {
        return {
          ok: false,
          status: 'failed',
          actuator_id: id,
          op,
          error: buildUnknownActuatorOpError(id, op).message,
        };
      }
      try {
        const validatedInput = definition.validateInput
          ? definition.validateInput(input)
          : (input as never);
        const output = await definition.handler(validatedInput, context);
        return { ok: true, status: 'succeeded', actuator_id: id, op, output };
      } catch (error) {
        return {
          ok: false,
          status: 'failed',
          actuator_id: id,
          op,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}

/**
 * Keep older hand-written actuators on the same SDK ABI while they migrate
 * their internal operation tables. The compatibility shape is deliberately
 * contained here so pipeline execution never needs a second dispatch path.
 */
export function defineLegacyPipelineActuator(options: {
  id: string;
  handleAction: LegacyPipelineActionHandler;
}): ActuatorDefinition {
  type LegacyInput = {
    op: string;
    type?: string;
    params?: Record<string, unknown>;
    options?: unknown;
    pipelineTrace?: unknown;
  };
  const ops: Record<string, ActuatorOpDefinition<LegacyInput>> = {
    execute: {
      kind: 'apply',
      validateInput(input: unknown): LegacyInput {
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          throw new Error(`Actuator ${options.id} input must be an object`);
        }
        const candidate = input as Record<string, unknown>;
        if (typeof candidate.op !== 'string' || candidate.op.length === 0) {
          throw new Error(`Actuator ${options.id} input requires op`);
        }
        return {
          op: candidate.op,
          ...(typeof candidate.type === 'string' ? { type: candidate.type } : {}),
          ...(candidate.params &&
          typeof candidate.params === 'object' &&
          !Array.isArray(candidate.params)
            ? { params: candidate.params as Record<string, unknown> }
            : {}),
          ...(candidate.options !== undefined ? { options: candidate.options } : {}),
          ...(candidate.pipelineTrace !== undefined
            ? { pipelineTrace: candidate.pipelineTrace }
            : {}),
        };
      },
      async handler(input, context) {
        const actionResult = await options.handleAction({
          action: 'pipeline',
          steps: [
            {
              type: input.type || 'apply',
              op: input.op,
              params: input.params || {},
            },
          ],
          context,
          ...(input.options !== undefined ? { options: input.options } : {}),
          ...(input.pipelineTrace !== undefined ? { pipelineTrace: input.pipelineTrace } : {}),
        });
        if (
          actionResult &&
          typeof actionResult === 'object' &&
          (actionResult as { status?: unknown }).status === 'failed'
        ) {
          const failedEntry = Array.isArray((actionResult as { results?: unknown }).results)
            ? (
                actionResult as { results: Array<{ status?: string; error?: string }> }
              ).results.find((entry) => entry.status === 'failed')
            : undefined;
          throw new Error(
            failedEntry?.error ||
              `Actuator sub-pipeline reported failure for ${options.id}:${input.op}`
          );
        }
        return actionResult;
      },
    },
  };
  return defineActuator({
    id: options.id,
    ops,
  });
}

/**
 * Expose an existing self-described operation catalog through the typed SDK.
 * The legacy handler remains the implementation seam for the migration wave,
 * but dispatch, descriptions, and failure conversion now use one ABI.
 */
export function defineCatalogBackedActuator(options: {
  id: string;
  describeOps: () => readonly ActuatorOpDescription[];
  /** Existing action handlers often expose a narrower domain input type. */
  handleAction: (input: never) => Promise<unknown> | unknown;
}): ActuatorDefinition {
  const compileInputValidator = (op: string, schema: unknown) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
    const contract = schema as Record<string, unknown>;
    const contractKind = contract['x-kyberion-contract'];
    if (contractKind === 'legacy-open' || contractKind === 'inferred-legacy') return undefined;
    const authored = schema as Record<string, unknown>;
    const properties =
      authored.properties &&
      typeof authored.properties === 'object' &&
      !Array.isArray(authored.properties)
        ? (authored.properties as Record<string, unknown>)
        : {};
    const validate = actuatorContractAjv.compile({
      ...authored,
      properties: { ...properties, ...PIPELINE_EXECUTION_METADATA_PROPERTIES },
    });
    return (input: unknown): unknown => {
      const probe = resolvePipelineInputPlaceholders(input, authored);
      if (validate(probe)) return input;
      const details = (validate.errors || [])
        .map((error) => {
          const property =
            error.keyword === 'additionalProperties' &&
            typeof error.params?.additionalProperty === 'string'
              ? ` (${error.params.additionalProperty})`
              : '';
          return `${error.instancePath || '/'} ${error.message || 'schema violation'}${property}`;
        })
        .join('; ');
      throw new Error(`Invalid input for ${options.id}:${op}: ${details}`);
    };
  };
  const ops: Record<string, ActuatorOpDefinition> = Object.fromEntries(
    options.describeOps().map((description) => {
      const inputSchema = description.input_schema;
      return [
        description.op,
        {
          kind: description.kind,
          ...(inputSchema !== undefined ? { input_schema: inputSchema } : {}),
          validateInput: compileInputValidator(description.op, inputSchema),
          async handler(input: unknown, context: Record<string, unknown>) {
            const params =
              input && typeof input === 'object' && !Array.isArray(input)
                ? (input as Record<string, unknown>)
                : {};
            const result = await options.handleAction({
              action: 'pipeline',
              steps: [{ type: description.kind, op: description.op, params }],
              context,
            } as never);
            if (
              result &&
              typeof result === 'object' &&
              (result as { status?: unknown }).status === 'failed'
            ) {
              const failed = Array.isArray((result as { results?: unknown }).results)
                ? (result as { results: Array<{ status?: string; error?: string }> }).results.find(
                    (entry) => entry.status === 'failed'
                  )
                : undefined;
              throw new Error(
                failed?.error ||
                  `Actuator sub-pipeline reported failure for ${options.id}:${description.op}`
              );
            }
            return result;
          },
        } satisfies ActuatorOpDefinition,
      ];
    })
  );
  return defineActuator({ id: options.id, ops });
}
