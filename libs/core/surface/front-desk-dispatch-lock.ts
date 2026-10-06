import { withLockSync } from '../foundation/lock-utils.js';
import {
  parseFrontDeskExecutionBinding,
  type FrontDeskExecutionBinding,
} from './front-desk-execution-contract.js';

// Only synchronous callbacks are supported. Intake, direct dispatch, settlement,
// and explicit recovery share this fence, including nested calls on this stack.
const held = new Set<string>();
export function withFrontDeskDispatchLock<T>(binding: FrontDeskExecutionBinding, fn: () => T): T {
  if (!parseFrontDeskExecutionBinding(binding)) throw new Error('invalid front-desk binding');
  const key = 'front-desk-dispatch-' + binding.work_item_id;
  if (held.has(key)) return fn();
  return withLockSync(key, () => {
    held.add(key);
    try {
      const result = fn();
      if (result && typeof (result as { then?: unknown }).then === 'function')
        throw new Error('front-desk dispatch fence requires a synchronous callback');
      return result;
    } finally {
      held.delete(key);
    }
  });
}

export function assertFrontDeskDispatchLockHeld(binding: FrontDeskExecutionBinding): void {
  if (!held.has('front-desk-dispatch-' + binding.work_item_id))
    throw new Error('front-desk dispatch fence required');
}
