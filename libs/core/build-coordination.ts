import { acquireLock, releaseLock } from './foundation/lock-utils.js';

/** All compiler writers and artifact inspectors share this process-safe mutex. */
const COMPILER_OUTPUTS = 'compiler-outputs';

export async function tryInspectCompilerOutputs<T>(
  inspect: () => Promise<T>
): Promise<{ deferred: true } | { deferred: false; value: T }> {
  if (!(await acquireLock(COMPILER_OUTPUTS, 0))) return { deferred: true };
  try {
    return { deferred: false, value: await inspect() };
  } finally {
    releaseLock(COMPILER_OUTPUTS);
  }
}

export async function withCompilerOutputs<T>(build: () => Promise<T>): Promise<T> {
  if (!(await acquireLock(COMPILER_OUTPUTS, 5000))) {
    throw new Error(
      'Compiler outputs are busy — another build or inspection holds the lock; retry after it completes'
    );
  }
  try {
    return await build();
  } finally {
    releaseLock(COMPILER_OUTPUTS);
  }
}
