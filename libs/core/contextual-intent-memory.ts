import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';

export type ScheduleSourceKind = 'operator_default_calendar' | 'google_calendar' | 'outlook_calendar' | 'browser_calendar';

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

function memoryPath(): string {
  return process.env.KYBERION_CONTEXTUAL_INTENT_MEMORY_PATH?.trim() ||
    pathResolver.knowledge('personal/contextual-intent-memory.json');
}

function defaultMemory(): ContextualIntentMemory {
  return { version: '1.0.0' };
}

export function loadContextualIntentMemory(): ContextualIntentMemory {
  const filePath = memoryPath();
  if (!safeExistsSync(filePath)) return defaultMemory();
  try {
    const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as ContextualIntentMemory;
    return parsed && typeof parsed === 'object' ? parsed : defaultMemory();
  } catch {
    return defaultMemory();
  }
}

export function saveContextualIntentMemory(memory: ContextualIntentMemory): void {
  safeWriteFile(memoryPath(), JSON.stringify(memory, null, 2));
}

export function resolveDefaultScheduleSource(): {
  source?: ScheduleSourceKind;
  calendarName?: string;
} {
  const memory = loadContextualIntentMemory();
  return {
    source: memory.schedule?.default_calendar_source,
    calendarName: memory.schedule?.default_calendar_name,
  };
}

export function resolveDefaultApprovalSystem(): {
  system?: string;
  scope?: string;
} {
  const memory = loadContextualIntentMemory();
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
}): ContextualIntentMemory {
  const memory = loadContextualIntentMemory();
  memory.schedule = {
    default_calendar_source: input.source,
    default_calendar_name: input.calendarName || memory.schedule?.default_calendar_name,
    last_confirmed_at: input.confirmed ? new Date().toISOString() : memory.schedule?.last_confirmed_at,
    last_seen_utterance: input.utterance || memory.schedule?.last_seen_utterance,
  };
  saveContextualIntentMemory(memory);
  return memory;
}

export function recordApprovalPreference(input: {
  system: string;
  scope?: string;
  utterance?: string;
  confirmed?: boolean;
}): ContextualIntentMemory {
  const memory = loadContextualIntentMemory();
  memory.approval = {
    default_approval_system: input.system,
    default_approval_scope: input.scope || memory.approval?.default_approval_scope,
    last_confirmed_at: input.confirmed ? new Date().toISOString() : memory.approval?.last_confirmed_at,
    last_seen_utterance: input.utterance || memory.approval?.last_seen_utterance,
  };
  saveContextualIntentMemory(memory);
  return memory;
}
