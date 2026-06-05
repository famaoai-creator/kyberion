import * as path from 'node:path';
import { safeReadFile, safeWriteFile, safeMkdir, safeExistsSync, pathResolver } from '@agent/core';
import type { FocusedInputState } from '@agent/core/os-automation';
import { activateApplication, detectFocusedInput } from '@agent/core/os-automation';

const COMPUTER_RUNTIME_DIR = pathResolver.shared('runtime/computer');
const FOCUS_TARGET_STORE_PATH = path.join(COMPUTER_RUNTIME_DIR, 'focused-targets.json');

function ensureComputerRuntimeDir() {
  if (!safeExistsSync(COMPUTER_RUNTIME_DIR)) {
    safeMkdir(COMPUTER_RUNTIME_DIR, { recursive: true });
  }
}

function loadFocusTargetStore(): Record<string, any> {
  if (!safeExistsSync(FOCUS_TARGET_STORE_PATH)) {
    return {};
  }
  try {
    return JSON.parse(String(safeReadFile(FOCUS_TARGET_STORE_PATH, { encoding: 'utf8' }) || '{}'));
  } catch {
    return {};
  }
}

function saveFocusTargetStore(store: Record<string, any>) {
  ensureComputerRuntimeDir();
  safeWriteFile(FOCUS_TARGET_STORE_PATH, JSON.stringify(store, null, 2));
}

function rememberFocusedTarget(explicitId: string | undefined, focusedInput: FocusedInputState) {
  const targetId = explicitId || `focus-${Date.now()}`;
  const store = loadFocusTargetStore();
  store[targetId] = {
    id: targetId,
    application: focusedInput.application,
    windowTitle: focusedInput.windowTitle,
    role: focusedInput.role,
    description: focusedInput.description,
    editable: focusedInput.editable,
    updatedAt: new Date().toISOString(),
  };
  saveFocusTargetStore(store);
  return targetId;
}

function loadRememberedFocusTarget(targetId?: string) {
  if (!targetId) {
    return null;
  }
  const store = loadFocusTargetStore();
  return store[targetId] || null;
}

function windowTitleMatches(expected: string, actual: string, matchPolicy: 'strict' | 'prefix' | 'contains') {
  switch (matchPolicy) {
    case 'prefix':
      return actual.startsWith(expected);
    case 'contains':
      return actual.includes(expected);
    case 'strict':
    default:
      return actual === expected;
  }
}

function getFocusedTargetMismatches(
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
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict',
) {
  if (!rememberedTarget) {
    return [];
  }

  const mismatches: string[] = [];
  if (rememberedTarget.application && focusedInput.application !== rememberedTarget.application) {
    mismatches.push(`application expected "${rememberedTarget.application}" got "${focusedInput.application || ''}"`);
  }
  if (rememberedTarget.windowTitle && !windowTitleMatches(rememberedTarget.windowTitle, focusedInput.windowTitle || '', matchPolicy)) {
    mismatches.push(`windowTitle expected "${rememberedTarget.windowTitle}" got "${focusedInput.windowTitle || ''}"`);
  }
  if (rememberedTarget.role && focusedInput.role && focusedInput.role !== rememberedTarget.role) {
    mismatches.push(`role expected "${rememberedTarget.role}" got "${focusedInput.role}"`);
  }
  return mismatches;
}

function assertFocusedTargetMatches(
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
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict',
) {
  if (!rememberedTarget || !targetId) {
    return;
  }

  const mismatches = getFocusedTargetMismatches(rememberedTarget, focusedInput, matchPolicy);

  if (mismatches.length > 0) {
    throw new Error(`Focused target guard failed for ${targetId}: ${mismatches.join(', ')}`);
  }
}

function detectFocusedInputWithGuard(
  rememberedTarget: {
    application?: string;
    windowTitle?: string;
    role?: string;
  } | null,
  targetId?: string,
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict',
) {
  let focusedInput = detectFocusedInput();
  const initialMismatch = getFocusedTargetMismatches(rememberedTarget, focusedInput, matchPolicy);
  if (initialMismatch.length === 0) {
    return focusedInput;
  }

  if (rememberedTarget?.application) {
    activateApplication(rememberedTarget.application);
    focusedInput = detectFocusedInput();
  }

  assertFocusedTargetMatches(rememberedTarget, focusedInput, targetId, matchPolicy);
  return focusedInput;
}

export const systemFocusHelpers = {
  loadFocusTargetStore,
  saveFocusTargetStore,
  rememberFocusedTarget,
  loadRememberedFocusTarget,
  windowTitleMatches,
  getFocusedTargetMismatches,
  assertFocusedTargetMatches,
  detectFocusedInputWithGuard,
};
