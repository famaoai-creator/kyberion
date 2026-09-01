import * as path from 'node:path';
import { defineCatalog, type GovernedCatalog } from './foundation/governed-catalog.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import type { ScopeContext } from './scope-context.js';
import { physicalScopedPath } from './physical-namespace.js';

const MEMORY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/intent-contract-memory.schema.json'
);
const POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/intent-contract-selection-policy.schema.json'
);
const MEMORY_SEED_PATH = pathResolver.knowledge('product/governance/intent-contract-memory.json');
const MEMORY_RUNTIME_PATH = pathResolver.shared('runtime/intent-contract-memory.json');
const POLICY_PATH = pathResolver.knowledge(
  'product/governance/intent-contract-selection-policy.json'
);
const ONTOLOGY_PATH = pathResolver.knowledge('product/governance/intent-domain-ontology.json');

type ContractKind =
  'pipeline' | 'schema' | 'task_session_policy' | 'mission_command' | 'direct_reply';

export interface IntentContractMemoryEntry {
  intent_id: string;
  correlation_id?: string;
  mission_id?: string;
  context_fingerprint: {
    domain?: string;
    merchant?: string;
    locale?: string;
    surface?: string;
    execution_shape?: string;
  };
  contract_ref: {
    kind: ContractKind;
    ref: string;
  };
  execution_shape: string;
  success_rate: number;
  sample_count: number;
  last_seen: string;
  last_error?: string;
  completion_summary?: {
    satisfied: boolean;
    delivered: string[];
    gaps: string[];
    next_step: string;
    confidence: number;
    evidence_refs: string[];
  };
}

interface IntentContractMemoryFile {
  version: string;
  entries: IntentContractMemoryEntry[];
}

interface IntentDomainOntologyEntry {
  intent_id: string;
  execution_shape: string;
}

interface IntentDomainOntologyFile {
  version: string;
  intents: IntentDomainOntologyEntry[];
}

export interface IntentContractSelectionPolicy {
  version: string;
  weights: {
    rule_match: number;
    success_rate: number;
    recent_failure_penalty: number;
    latency_cost: number;
  };
  thresholds: {
    min_sample_count_for_autoselect: number;
    min_score_delta_for_override: number;
  };
  risk_controls: {
    high_stakes_requires_approval: boolean;
    allow_fallback_when_no_memory: boolean;
  };
}

export interface ContractCandidate {
  intent_id: string;
  contract_ref: {
    kind: ContractKind;
    ref: string;
  };
  execution_shape: string;
  score: number;
  source: 'memory' | 'default';
}

const memorySnapshotCache = new Map<string, IntentContractMemoryFile>();

function globalRuntimeMemoryPath(): string {
  const configured = getRegisteredEnvText('KYBERION_INTENT_CONTRACT_MEMORY_RUNTIME_PATH')?.trim();
  if (!configured) return MEMORY_RUNTIME_PATH;
  return path.isAbsolute(configured) ? configured : pathResolver.rootResolve(configured);
}

function runtimeMemoryPath(scope?: ScopeContext): string {
  const base = globalRuntimeMemoryPath();
  const candidate = !scope?.tenant_slug
    ? base
    : `${physicalScopedPath(path.dirname(base), { ...scope, scope_kind: scope.mission_id ? 'mission' : 'tenant' })}/${path.basename(base)}`;
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
}

function defaultMemory(): IntentContractMemoryFile {
  return { version: '1.0.0', entries: [] };
}

function memoryCatalog(filePath: string): GovernedCatalog<IntentContractMemoryFile> {
  return defineCatalog<IntentContractMemoryFile>({
    id: 'intent-contract-memory',
    path: filePath,
    schema: MEMORY_SCHEMA_PATH,
  });
}

const policyCatalog = defineCatalog<IntentContractSelectionPolicy>({
  id: 'intent-contract-selection-policy',
  path: POLICY_PATH,
  schema: POLICY_SCHEMA_PATH,
});

const ontologyCatalog = defineCatalog<IntentDomainOntologyFile>({
  id: 'intent-domain-ontology',
  path: ONTOLOGY_PATH,
  schema: pathResolver.knowledge('product/schemas/intent-domain-ontology.schema.json'),
});

function loadMemoryFile(filePath: string): IntentContractMemoryFile | null {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath)) return null;
  return memoryCatalog(safePath).load();
}

function memoryEntryKey(
  entry: Pick<IntentContractMemoryEntry, 'intent_id' | 'contract_ref'>
): string {
  return `${entry.intent_id}::${entry.contract_ref.kind}::${entry.contract_ref.ref}`;
}

function loadOntologyByIntentId(): Map<string, IntentDomainOntologyEntry> {
  const parsed = ontologyCatalog.load();
  const mapped = new Map<string, IntentDomainOntologyEntry>();
  for (const entry of parsed.intents) {
    if (!entry.intent_id) continue;
    mapped.set(entry.intent_id, entry);
  }
  return mapped;
}

export function loadIntentContractMemory(): IntentContractMemoryFile {
  return loadIntentContractMemorySnapshot();
}

export function loadIntentContractMemoryStore(scope?: ScopeContext): IntentContractMemoryFile {
  const fallback = defaultMemory();
  const seed = loadMemoryFile(MEMORY_SEED_PATH) || fallback;
  const runtime = loadMemoryFile(runtimeMemoryPath(scope)) || fallback;

  const mergedByKey = new Map<string, IntentContractMemoryEntry>();
  for (const entry of seed.entries) {
    mergedByKey.set(memoryEntryKey(entry), entry);
  }
  for (const entry of runtime.entries) {
    // Runtime memory overrides seed memory for the same intent-contract pair.
    mergedByKey.set(memoryEntryKey(entry), entry);
  }
  return {
    version: runtime.version || seed.version || '1.0.0',
    entries: Array.from(mergedByKey.values()),
  };
}

export function loadIntentContractMemorySnapshot(scope?: ScopeContext): IntentContractMemoryFile {
  const key = runtimeMemoryPath(scope);
  const cached = memorySnapshotCache.get(key);
  if (cached) return cached;
  const snapshot = loadIntentContractMemoryStore(scope);
  memorySnapshotCache.set(key, snapshot);
  return snapshot;
}

export function refreshIntentContractMemorySnapshot(
  scope?: ScopeContext
): IntentContractMemoryFile {
  const snapshot = loadIntentContractMemoryStore(scope);
  memorySnapshotCache.set(runtimeMemoryPath(scope), snapshot);
  return snapshot;
}

export function saveIntentContractMemory(
  memory: IntentContractMemoryFile,
  scope?: ScopeContext
): void {
  const filePath = runtimeMemoryPath(scope);
  memoryCatalog(filePath).validate(memory, filePath);
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(memory, null, 2));
}

export function loadIntentContractSelectionPolicy(): IntentContractSelectionPolicy {
  return policyCatalog.load();
}

export function resolveIntentContractMemoryPaths(scope?: ScopeContext): {
  seed: string;
  runtime: string;
} {
  return { seed: MEMORY_SEED_PATH, runtime: runtimeMemoryPath(scope) };
}

function defaultContractForIntent(intentId: string): ContractCandidate | null {
  const ontology = loadOntologyByIntentId().get(intentId);
  if (!ontology) return null;
  const shape = ontology.execution_shape;
  if (shape === 'pipeline') {
    return {
      intent_id: intentId,
      contract_ref: { kind: 'pipeline', ref: `${intentId}` },
      execution_shape: shape,
      score: 0.5,
      source: 'default',
    };
  }
  if (shape === 'mission') {
    return {
      intent_id: intentId,
      contract_ref: { kind: 'mission_command', ref: 'mission_controller' },
      execution_shape: shape,
      score: 0.45,
      source: 'default',
    };
  }
  if (shape === 'task_session') {
    return {
      intent_id: intentId,
      contract_ref: { kind: 'task_session_policy', ref: 'task-session-policy' },
      execution_shape: shape,
      score: 0.45,
      source: 'default',
    };
  }
  return {
    intent_id: intentId,
    contract_ref: { kind: 'direct_reply', ref: 'direct-reply' },
    execution_shape: shape,
    score: 0.4,
    source: 'default',
  };
}

export function selectContractCandidates(
  intentId: string,
  maxCandidates = 3,
  scope?: ScopeContext
): ContractCandidate[] {
  const policy = loadIntentContractSelectionPolicy();
  const memory = loadIntentContractMemorySnapshot(scope);
  const remembered: ContractCandidate[] = memory.entries
    .filter((entry) => entry.intent_id === intentId)
    .map((entry) => ({
      intent_id: intentId,
      contract_ref: entry.contract_ref,
      execution_shape: entry.execution_shape,
      score:
        policy.weights.rule_match +
        policy.weights.success_rate * entry.success_rate -
        policy.weights.recent_failure_penalty * (entry.last_error ? 1 : 0),
      source: 'memory' as const,
    }))
    .sort((a, b) => b.score - a.score);

  const defaults = defaultContractForIntent(intentId);
  const merged: ContractCandidate[] = [...remembered];
  if (
    defaults &&
    !merged.some(
      (item) =>
        item.contract_ref.kind === defaults.contract_ref.kind &&
        item.contract_ref.ref === defaults.contract_ref.ref
    )
  ) {
    merged.push(defaults);
  }
  return merged.slice(0, Math.max(1, maxCandidates));
}

export function recordIntentContractOutcome(input: {
  intent_id: string;
  execution_shape: string;
  contract_ref: { kind: ContractKind; ref: string };
  success: boolean;
  error?: string;
  correlation_id?: string;
  mission_id?: string;
  context_fingerprint?: IntentContractMemoryEntry['context_fingerprint'];
  completion_summary?: IntentContractMemoryEntry['completion_summary'];
  scope?: ScopeContext;
}): IntentContractMemoryEntry {
  const memory = loadIntentContractMemoryStore(input.scope);
  const idx = memory.entries.findIndex(
    (entry) =>
      entry.intent_id === input.intent_id &&
      entry.contract_ref.kind === input.contract_ref.kind &&
      entry.contract_ref.ref === input.contract_ref.ref
  );

  if (idx < 0) {
    const created: IntentContractMemoryEntry = {
      intent_id: input.intent_id,
      ...(input.correlation_id ? { correlation_id: input.correlation_id } : {}),
      ...(input.mission_id ? { mission_id: input.mission_id } : {}),
      context_fingerprint: input.context_fingerprint || {},
      contract_ref: input.contract_ref,
      execution_shape: input.execution_shape,
      success_rate: input.success ? 1 : 0,
      sample_count: 1,
      last_seen: new Date().toISOString(),
      ...(input.error ? { last_error: input.error } : {}),
      ...(input.completion_summary ? { completion_summary: input.completion_summary } : {}),
    };
    memory.entries.push(created);
    saveIntentContractMemory(memory, input.scope);
    return created;
  }

  const prev = memory.entries[idx];
  const nextCount = prev.sample_count + 1;
  const nextRate = (prev.success_rate * prev.sample_count + (input.success ? 1 : 0)) / nextCount;
  const updated: IntentContractMemoryEntry = {
    ...prev,
    ...(input.correlation_id ? { correlation_id: input.correlation_id } : {}),
    ...(input.mission_id ? { mission_id: input.mission_id } : {}),
    execution_shape: input.execution_shape,
    context_fingerprint: input.context_fingerprint || prev.context_fingerprint,
    sample_count: nextCount,
    success_rate: Number(nextRate.toFixed(4)),
    last_seen: new Date().toISOString(),
    last_error: input.success ? undefined : input.error || prev.last_error,
    ...(input.completion_summary ? { completion_summary: input.completion_summary } : {}),
  };
  memory.entries[idx] = updated;
  saveIntentContractMemory(memory, input.scope);
  return updated;
}
