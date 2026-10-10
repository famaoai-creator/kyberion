/**
 * system-focus-target-delegates.ts — thin wrappers over system-focus-helpers.
 * Extracted from system-pipeline-core-helpers.ts to keep that module under
 * the max-file-lines ratchet; consumers import the same names re-exported
 * from system-pipeline-core-helpers.js.
 */
import type { FocusedInputState } from '@agent/core/virtual/os-automation';
import { systemFocusHelpers } from './system-focus-helpers.js';

export function loadFocusTargetStore(): import('./system-focus-helpers.js').FocusTargetStore {
  return systemFocusHelpers.loadFocusTargetStore();
}

export function saveFocusTargetStore(store: import('./system-focus-helpers.js').FocusTargetStore) {
  systemFocusHelpers.saveFocusTargetStore(store);
}

export function rememberFocusedTarget(
  explicitId: string | undefined,
  focusedInput: FocusedInputState
) {
  return systemFocusHelpers.rememberFocusedTarget(explicitId, focusedInput);
}

export function loadRememberedFocusTarget(targetId?: string) {
  return systemFocusHelpers.loadRememberedFocusTarget(targetId);
}

export function detectFocusedInputWithGuard(
  rememberedTarget: {
    application?: string;
    windowTitle?: string;
    role?: string;
  } | null,
  targetId?: string,
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict'
) {
  return systemFocusHelpers.detectFocusedInputWithGuard(rememberedTarget, targetId, matchPolicy);
}

export function assertFocusedTargetMatches(
  rememberedTarget: {
    application?: string;
    windowTitle?: string;
    role?: string;
  } | null,
  focusedInput: {
    application?: string;
    windowTitle?: string;
    role?: string;
  },
  targetId?: string,
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict'
) {
  return systemFocusHelpers.assertFocusedTargetMatches(
    rememberedTarget,
    focusedInput,
    targetId,
    matchPolicy
  );
}

export function getFocusedTargetMismatches(
  rememberedTarget: {
    application?: string;
    windowTitle?: string;
    role?: string;
  } | null,
  focusedInput: {
    application?: string;
    windowTitle?: string;
    role?: string;
  },
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict'
) {
  return systemFocusHelpers.getFocusedTargetMismatches(rememberedTarget, focusedInput, matchPolicy);
}

export function windowTitleMatches(
  expected: string,
  actual: string,
  matchPolicy: 'strict' | 'prefix' | 'contains'
) {
  return systemFocusHelpers.windowTitleMatches(expected, actual, matchPolicy);
}
