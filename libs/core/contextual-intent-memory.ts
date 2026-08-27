import { pathResolver } from './path-resolver.js';
import { readJson } from './foundation/json.js';
import { safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import type { ScopeContext } from './scope-context.js';
import { physicalScopedPath } from './physical-namespace.js';
import { getRegisteredEnvText } from './foundation/env.js';

export type ScheduleSourceKind =
  'operator_default_calendar' | 'google_calendar' | 'outlook_calendar' | 'browser_calendar';

export interface ContextualIntentMemory {
  version: string;
  schedule?: {
    default_calendar_source?: ScheduleSourceKind;
    default_calendar_name?: string;
    last_confirmed_at?: string;
    last_seen_utterance?: string;
  };
  approval?: {
    default_approval_system?: string;
    default_approval_scope?: string;
    last_confirmed_at?: string;
    last_seen_utterance?: string;
  };
}

function memoryPath(scope?: ScopeContext): string {
  const configuredPath = getRegisteredEnvText('KYBERION_CONTEXTUAL_INTENT_MEMORY_PATH')?.trim();
  const base = configuredPath
    ? pathResolver.rootResolve(configuredPath)
    : pathResolver.knowledge('personal/contextual-intent-memory.json');
  if (!scope?.tenant_slug) return base;
  return (
    physicalScopedPath(path.dirname(base), {
      ...scope,
      scope_kind: scope.mission_id ? 'mission' : 'tenant',
    }) + `/${path.basename(base)}`
  );
}

function defaultMemory(): ContextualIntentMemory {
  return { version: '1.0.0' };
}

export function loadContextualIntentMemory(scope?: ScopeContext): ContextualIntentMemory {
  const filePath = memoryPath(scope);
  if (!safeExistsSync(filePath)) return defaultMemory();
  try {
    const parsed = readJson<ContextualIntentMemory>(filePath);
    return parsed && typeof parsed === 'object' ? parsed : defaultMemory();
  } catch {
    return defaultMemory();
  }
}

export function saveContextualIntentMemory(
  memory: ContextualIntentMemory,
  scope?: ScopeContext
): void {
  const filePath = memoryPath(scope);
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) {
    safeMkdir(dir, { recursive: true });
  }
  safeWriteFile(filePath, JSON.stringify(memory, null, 2));
}

export function resolveDefaultScheduleSource(scope?: ScopeContext): {
  source?: ScheduleSourceKind;
  calendarName?: string;
} {
  const memory = loadContextualIntentMemory(scope);
  return {
    source: memory.schedule?.default_calendar_source,
    calendarName: memory.schedule?.default_calendar_name,
  };
}

export function resolveDefaultApprovalSystem(scope?: ScopeContext): {
  system?: string;
  scope?: string;
} {
  const memory = loadContextualIntentMemory(scope);
  return {
    system: memory.approval?.default_approval_system,
    scope: memory.approval?.default_approval_scope,
  };
}

export function recordSchedulePreference(input: {
  source: ScheduleSourceKind;
  calendarName?: string;
  utterance?: string;
  confirmed?: boolean;
  scope?: ScopeContext;
}): ContextualIntentMemory {
  const memory = loadContextualIntentMemory(input.scope);
  memory.schedule = {
    default_calendar_source: input.source,
    default_calendar_name: input.calendarName || memory.schedule?.default_calendar_name,
    last_confirmed_at: input.confirmed
      ? new Date().toISOString()
      : memory.schedule?.last_confirmed_at,
    last_seen_utterance: input.utterance || memory.schedule?.last_seen_utterance,
  };
  saveContextualIntentMemory(memory, input.scope);
  return memory;
}

export function recordApprovalPreference(input: {
  system: string;
  scope?: string;
  utterance?: string;
  confirmed?: boolean;
  scopeContext?: ScopeContext;
}): ContextualIntentMemory {
  const memory = loadContextualIntentMemory(input.scopeContext);
  memory.approval = {
    default_approval_system: input.system,
    default_approval_scope: input.scope || memory.approval?.default_approval_scope,
    last_confirmed_at: input.confirmed
      ? new Date().toISOString()
      : memory.approval?.last_confirmed_at,
    last_seen_utterance: input.utterance || memory.approval?.last_seen_utterance,
  };
  saveContextualIntentMemory(memory, input.scopeContext);
  return memory;
}
import * as path from 'node:path';
