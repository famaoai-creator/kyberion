import * as path from 'node:path';
import {
  assertSafeRepositoryPath,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { readJson } from '@agent/core/foundation';
import type { FocusedInputState } from '@agent/core/os-automation';
import { activateApplication, detectFocusedInput } from '@agent/core/os-automation';

const COMPUTER_RUNTIME_DIR = pathResolver.shared('runtime/computer');
const FOCUS_TARGET_STORE_PATH = path.join(COMPUTER_RUNTIME_DIR, 'focused-targets.json');

function safeFocusTargetStorePath(options: { allowMissingLeaf?: boolean } = {}): string {
  return assertSafeRepositoryPath(FOCUS_TARGET_STORE_PATH, options);
}

export interface FocusTargetRecord {
  id: string;
  application?: string;
  windowTitle?: string;
  role?: string;
  description?: string;
  editable?: boolean;
  updatedAt?: string;
}

export type FocusTargetStore = Record<string, FocusTargetRecord>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isSafeStoreKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return value === undefined ? undefined : typeof value === 'string' ? value : undefined;
}

/** Normalize persisted focus targets before any guard or activation uses them. */
export function parseFocusTargetStore(value: unknown): FocusTargetStore {
  if (!isRecord(value)) return {};

  const store: FocusTargetStore = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (!isSafeStoreKey(key) || !isRecord(candidate) || candidate.id !== key) continue;
    if (typeof candidate.id !== 'string' || candidate.id.trim().length === 0) continue;

    const stringFields = ['application', 'windowTitle', 'role', 'description', 'updatedAt'];
    if (
      stringFields.some(
        (field) => candidate[field] !== undefined && typeof candidate[field] !== 'string'
      )
    ) {
      continue;
    }
    if (candidate.editable !== undefined && typeof candidate.editable !== 'boolean') continue;

    store[key] = {
      id: candidate.id,
      ...(optionalString(candidate, 'application') !== undefined
        ? { application: optionalString(candidate, 'application') }
        : {}),
      ...(optionalString(candidate, 'windowTitle') !== undefined
        ? { windowTitle: optionalString(candidate, 'windowTitle') }
        : {}),
      ...(optionalString(candidate, 'role') !== undefined
        ? { role: optionalString(candidate, 'role') }
        : {}),
      ...(optionalString(candidate, 'description') !== undefined
        ? { description: optionalString(candidate, 'description') }
        : {}),
      ...(typeof candidate.editable === 'boolean' ? { editable: candidate.editable } : {}),
      ...(optionalString(candidate, 'updatedAt') !== undefined
        ? { updatedAt: optionalString(candidate, 'updatedAt') }
        : {}),
    };
  }
  return store;
}

function ensureComputerRuntimeDir() {
  const safeRuntimeDir = assertSafeRepositoryPath(COMPUTER_RUNTIME_DIR, {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(safeRuntimeDir)) {
    safeMkdir(safeRuntimeDir, { recursive: true });
  }
}

function loadFocusTargetStore(): FocusTargetStore {
  const safeStorePath = safeFocusTargetStorePath({ allowMissingLeaf: true });
  if (!safeExistsSync(safeStorePath)) {
    return {};
  }
  try {
    return parseFocusTargetStore(readJson<unknown>(safeStorePath));
  } catch {
    return {};
  }
}

function saveFocusTargetStore(store: FocusTargetStore) {
  ensureComputerRuntimeDir();
  safeWriteFile(
    safeFocusTargetStorePath({ allowMissingLeaf: true }),
    JSON.stringify(parseFocusTargetStore(store), null, 2)
  );
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

function windowTitleMatches(
  expected: string,
  actual: string,
  matchPolicy: 'strict' | 'prefix' | 'contains'
) {
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
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict'
) {
  if (!rememberedTarget) {
    return [];
  }

  const mismatches: string[] = [];
  if (rememberedTarget.application && focusedInput.application !== rememberedTarget.application) {
    mismatches.push(
      `application expected "${rememberedTarget.application}" got "${focusedInput.application || ''}"`
    );
  }
  if (
    rememberedTarget.windowTitle &&
    !windowTitleMatches(rememberedTarget.windowTitle, focusedInput.windowTitle || '', matchPolicy)
  ) {
    mismatches.push(
      `windowTitle expected "${rememberedTarget.windowTitle}" got "${focusedInput.windowTitle || ''}"`
    );
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
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict'
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
  matchPolicy: 'strict' | 'prefix' | 'contains' = 'strict'
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
  parseFocusTargetStore,
  saveFocusTargetStore,
  rememberFocusedTarget,
  loadRememberedFocusTarget,
  windowTitleMatches,
  getFocusedTargetMismatches,
  assertFocusedTargetMatches,
  detectFocusedInputWithGuard,
};
