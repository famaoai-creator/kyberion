import AjvModule, { type ValidateFunction } from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import type { ContextualIntentFrame } from './contextual-intent-frame.js';
import type { ScopeContext } from './scope-context.js';
import { physicalScopedPath } from './physical-namespace.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;
const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const LEARNING_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/contextual-intent-learning.schema.json'
);

function learningStorePath(scope?: ScopeContext): string {
  const base =
    process.env.KYBERION_CONTEXTUAL_INTENT_LEARNING_PATH?.trim() ||
    pathResolver.knowledge('personal/contextual-intent-learning.json');
  if (!scope?.tenant_slug) return base;
  return `${physicalScopedPath(path.dirname(base), { ...scope, scope_kind: scope.mission_id ? 'mission' : 'tenant' })}/${path.basename(base)}`;
}

export interface ContextualIntentLearningEntry {
  id: string;
  utterance: string;
  intent_id: string;
  action: ContextualIntentFrame['action'];
  object: ContextualIntentFrame['object'];
  subject: ContextualIntentFrame['subject'];
  date_range?: NonNullable<ContextualIntentFrame['date_range']>['value'];
  source_binding?: NonNullable<ContextualIntentFrame['source_binding']>['selected'];
  clarification_needed: boolean;
  confirmed: boolean;
  tier: 'personal' | 'confidential' | 'public';
  locale: ContextualIntentFrame['locale'];
  response_shape?: string;
  notes?: string;
  recorded_at: string;
  expires_at?: string;
}

export interface ContextualIntentLearningStore {
  version: string;
  entries: ContextualIntentLearningEntry[];
}

let contextualIntentLearningValidateFn: ValidateFunction | null = null;

function ensureContextualIntentLearningValidator(): ValidateFunction {
  if (contextualIntentLearningValidateFn) return contextualIntentLearningValidateFn;
  contextualIntentLearningValidateFn = compileSchemaFromPath(ajv, LEARNING_SCHEMA_PATH);
  return contextualIntentLearningValidateFn;
}

function defaultStore(): ContextualIntentLearningStore {
  return { version: '1.0.0', entries: [] };
}

function readStore(scope?: ScopeContext): ContextualIntentLearningStore {
  const filePath = learningStorePath(scope);
  if (!safeExistsSync(filePath)) return defaultStore();
  try {
    const parsed = JSON.parse(
      safeReadFile(filePath, { encoding: 'utf8' }) as string
    ) as ContextualIntentLearningStore;
    const validate = ensureContextualIntentLearningValidator();
    if (!validate(parsed)) return defaultStore();
    return parsed;
  } catch {
    return defaultStore();
  }
}

function writeStore(store: ContextualIntentLearningStore, scope?: ScopeContext): void {
  const filePath = learningStorePath(scope);
  const validate = ensureContextualIntentLearningValidator();
  if (!validate(store)) {
    const errors = (validate.errors || [])
      .map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`)
      .join('; ');
    throw new Error(`Invalid contextual-intent-learning store: ${errors}`);
  }
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(store, null, 2));
}

export function loadContextualIntentLearningStore(
  scope?: ScopeContext
): ContextualIntentLearningStore {
  return readStore(scope);
}

export function recordContextualIntentLearning(input: {
  utterance: string;
  intentId: string;
  frame: ContextualIntentFrame;
  clarificationNeeded?: boolean;
  confirmed: boolean;
  tier: 'personal' | 'confidential' | 'public';
  responseShape?: string;
  notes?: string;
  expiresAt?: string;
  scope?: ScopeContext;
}): ContextualIntentLearningEntry {
  const store = readStore(input.scope);
  const entry: ContextualIntentLearningEntry = {
    id: randomUUID(),
    utterance: input.utterance,
    intent_id: input.intentId,
    action: input.frame.action,
    object: input.frame.object,
    subject: input.frame.subject,
    date_range: input.frame.date_range?.value,
    source_binding: input.frame.source_binding.selected,
    clarification_needed:
      typeof input.clarificationNeeded === 'boolean'
        ? input.clarificationNeeded
        : input.frame.missing.length > 0,
    confirmed: input.confirmed,
    tier: input.tier,
    locale: input.frame.locale,
    response_shape: input.responseShape,
    notes: input.notes,
    recorded_at: new Date().toISOString(),
    expires_at: input.expiresAt,
  };
  store.entries = [...store.entries, entry].slice(-500);
  writeStore(store, input.scope);
  return entry;
}
