export type MissionWorkerCoreDispatcher = (
  input: unknown,
  traceContext: unknown,
  delegationChain?: unknown,
  gapRecorder?: unknown
) => Promise<unknown>;

let dispatcher: MissionWorkerCoreDispatcher | null = null;

export function registerMissionWorkerCoreDispatcher(next: MissionWorkerCoreDispatcher): void {
  dispatcher = next;
}

export async function dispatchThroughMissionWorkerCore(
  input: unknown,
  traceContext: unknown,
  delegationChain?: unknown,
  gapRecorder?: unknown
): Promise<unknown> {
  if (!dispatcher) throw new Error('Mission worker core dispatcher is not initialized');
  return dispatcher(input, traceContext, delegationChain, gapRecorder);
}
