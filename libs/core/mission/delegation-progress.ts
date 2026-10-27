import { AsyncLocalStorage } from 'node:async_hooks';

/** Semantic protocol events only: transport bytes and timer heartbeats are not progress. */
export type DelegationProgress = 'assistant_message' | 'tool_started' | 'tool_completed';
type Reporter = (event: DelegationProgress) => void;
const progressContext = new AsyncLocalStorage<{
  reporter: Reporter;
  mode: 'bounded' | 'continuous';
}>();

export function withDelegationProgress<T>(
  reporter: Reporter,
  run: () => Promise<T>,
  mode: 'bounded' | 'continuous' = 'bounded'
): Promise<T> {
  return progressContext.run({ reporter, mode }, run);
}

export function currentDelegationExecutionMode(): 'bounded' | 'continuous' {
  return progressContext.getStore()?.mode ?? 'bounded';
}

/** Capture per turn, never per pooled process: callbacks must not report to an earlier caller. */
export function captureDelegationProgressReporter(): Reporter {
  return progressContext.getStore()?.reporter ?? (() => undefined);
}
