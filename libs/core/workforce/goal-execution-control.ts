/** A continuous goal renews admission per step instead of inventing a total turn ceiling. */
export function goalTurnLimit(
  options: {
    executionMode?: 'bounded' | 'continuous';
    maxTurns?: number;
    preStep?: readonly unknown[];
  },
  boundedDefault: number
): number {
  if (options.executionMode === 'continuous' && !options.preStep?.length) {
    throw new Error(
      '[GOAL_CONTINUOUS_ADMISSION_REQUIRED] Continuous goals require per-step admission'
    );
  }
  return options.maxTurns ?? (options.executionMode === 'continuous' ? Infinity : boundedDefault);
}

/** Cancellation abandons the wait, not proof that an external operation never happened. */
export async function awaitGoalOperation<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T> | T
): Promise<T> {
  if (!signal) return run();
  const cancelled = () => signal.reason ?? new Error('[GOAL_CANCELLED] cancellation requested');
  if (signal.aborted) throw cancelled();
  let onAbort: () => void = () => {};
  const stop = new Promise<never>((_, reject) => {
    onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => {
        if (signal.aborted) throw cancelled();
        return run();
      }),
      stop,
    ]);
    if (signal.aborted) throw cancelled();
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
