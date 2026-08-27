export type SuperNerveExecutor = (
  steps: unknown,
  initialContext?: Record<string, unknown>,
  options?: Record<string, unknown>
) => Promise<unknown>;

let executor: SuperNerveExecutor | null = null;

export function registerSuperNerveExecutor(next: SuperNerveExecutor): void {
  executor = next;
}

export async function executeRegisteredSuperPipeline(
  steps: unknown,
  initialContext: Record<string, unknown> = {},
  options: Record<string, unknown> = {}
): Promise<unknown> {
  if (!executor) throw new Error('Super-Nerve executor is not initialized');
  return executor(steps, initialContext, options);
}
