import type { WisdomContext } from './wisdom-context.js';
import type { ExecutionKind } from './wisdom-result.js';

export type WisdomOperationKind = 'capture' | 'transform' | 'apply';

export interface WisdomOperationSpec<Input = unknown, Output = unknown> {
  op: string;
  kind: WisdomOperationKind;
  inputSchema: object;
  execute(input: Input, context: WisdomContext): Promise<Output>;
  idempotency: 'read' | 'idempotent_write' | 'non_idempotent';
  owner: string;
  deprecated?: boolean;
  forwardTo?: { actuator: string; op: string };
  canonicalOp?: string;
  executionKind?: ExecutionKind;
}

export type WisdomOperationExecutor = (
  op: string,
  input: unknown,
  context: WisdomContext
) => Promise<unknown>;

export function createWisdomOperationSpec(
  descriptor: Omit<WisdomOperationSpec, 'execute'>,
  execute: WisdomOperationExecutor
): WisdomOperationSpec {
  return {
    ...descriptor,
    execute: (input, context) => execute(descriptor.op, input, context),
  };
}
