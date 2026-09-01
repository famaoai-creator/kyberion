import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import type { ContextualIntentFrame } from './contextual-intent-frame.js';
import type { ScopeContext } from './scope-context.js';
import { physicalScopedPath } from './physical-namespace.js';
const LEARNING_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/contextual-intent-learning.schema.json'
);

function learningStorePath(scope?: ScopeContext): string {
  const base =
    getRegisteredEnvText('KYBERION_CONTEXTUAL_INTENT_LEARNING_PATH')?.trim() ||
    pathResolver.knowledge('personal/contextual-intent-learning.json');
  const candidate = !scope?.tenant_slug
    ? base
    : `${physicalScopedPath(path.dirname(base), { ...scope, scope_kind: scope.mission_id ? 'mission' : 'tenant' })}/${path.basename(base)}`;
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
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

function defaultStore(): ContextualIntentLearningStore {
  return { version: '1.0.0', entries: [] };
}

function contextualIntentLearningCatalog(
  scope?: ScopeContext
): GovernedCatalog<ContextualIntentLearningStore> {
  return defineCatalog<ContextualIntentLearningStore>({
    id: 'contextual-intent-learning',
    path: learningStorePath(scope),
    schema: LEARNING_SCHEMA_PATH,
    fallback: defaultStore,
    fallbackOnInvalid: true,
  });
}

function readStore(scope?: ScopeContext): ContextualIntentLearningStore {
  return contextualIntentLearningCatalog(scope).load();
}

function writeStore(store: ContextualIntentLearningStore, scope?: ScopeContext): void {
  const filePath = learningStorePath(scope);
  try {
    contextualIntentLearningCatalog(scope).validate(store, filePath);
  } catch (error) {
    throw new Error(
      `Invalid contextual-intent-learning store: ${error instanceof Error ? error.message : String(error)}`
    );
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
