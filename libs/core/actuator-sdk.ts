import { buildUnknownActuatorOpError, type PipelineStepType } from './actuator-op-registry.js';
import * as addFormatsModule from 'ajv-formats';
import { createAjv } from './foundation/ajv.js';
import { resolvePipelineInputPlaceholders } from './pipeline-input-contract.js';

type AddFormats = (ajv: ReturnType<typeof createAjv>) => unknown;
const addFormats =
  (addFormatsModule as unknown as { default?: AddFormats }).default ||
  (addFormatsModule as unknown as AddFormats);

const actuatorContractAjv = createAjv();
addFormats(actuatorContractAjv);

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
