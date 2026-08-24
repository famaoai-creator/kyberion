import { buildUnknownActuatorOpError, type PipelineStepType } from './actuator-op-registry.js';

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
