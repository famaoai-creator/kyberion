import AjvModule, { type ValidateFunction } from 'ajv';
import { compileSchemaFromPath } from './schema-loader.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const MEMORY_SCHEMA_PATH = pathResolver.knowledge('public/schemas/intent-contract-memory.schema.json');
const POLICY_SCHEMA_PATH = pathResolver.knowledge('public/schemas/intent-contract-selection-policy.schema.json');
const MEMORY_SEED_PATH = pathResolver.knowledge('public/governance/intent-contract-memory.json');
const MEMORY_RUNTIME_PATH = pathResolver.shared('runtime/intent-contract-memory.json');
const POLICY_PATH = pathResolver.knowledge('public/governance/intent-contract-selection-policy.json');
const ONTOLOGY_PATH = pathResolver.knowledge('public/governance/intent-domain-ontology.json');

type ContractKind = 'pipeline' | 'schema' | 'task_session_policy' | 'mission_command' | 'direct_reply';

export interface IntentContractMemoryEntry {
  intent_id: string;
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
}

interface IntentContractMemoryFile {
  version: string;
  entries: IntentContractMemoryEntry[];
}

interface IntentDomainOntologyEntry {
  intent_id: string;
  execution_shape: string;
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

let memoryValidateFn: ValidateFunction | null = null;
let policyValidateFn: ValidateFunction | null = null;

function ensureMemoryValidator(): ValidateFunction {
  if (memoryValidateFn) return memoryValidateFn;
  memoryValidateFn = compileSchemaFromPath(ajv, MEMORY_SCHEMA_PATH);
  return memoryValidateFn;
}

function ensurePolicyValidator(): ValidateFunction {
  if (policyValidateFn) return policyValidateFn;
  policyValidateFn = compileSchemaFromPath(ajv, POLICY_SCHEMA_PATH);
  return policyValidateFn;
}

function parseJson<T>(filePath: string): T {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as T;
}

function memoryEntryKey(entry: Pick<IntentContractMemoryEntry, 'intent_id' | 'contract_ref'>): string {
  return `${entry.intent_id}::${entry.contract_ref.kind}::${entry.contract_ref.ref}`;
}

function validateIntentContractMemory(memory: IntentContractMemoryFile): IntentContractMemoryFile {
  const validate = ensureMemoryValidator();
  if (!validate(memory)) {
    const errors = (validate.errors || []).map((e) => `${e.instancePath || '/'} ${e.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid intent-contract-memory: ${errors}`);
  }
  return memory;
}

function loadOntologyByIntentId(): Map<string, IntentDomainOntologyEntry> {
  const parsed = parseJson<{ intents?: IntentDomainOntologyEntry[] }>(ONTOLOGY_PATH);
  const mapped = new Map<string, IntentDomainOntologyEntry>();
  for (const entry of parsed.intents || []) {
    if (!entry.intent_id) continue;
    mapped.set(entry.intent_id, entry);
  }
  return mapped;
}

export function loadIntentContractMemory(): IntentContractMemoryFile {
  const fallback: IntentContractMemoryFile = { version: '1.0.0', entries: [] };
  const seed = safeExistsSync(MEMORY_SEED_PATH) ? validateIntentContractMemory(parseJson<IntentContractMemoryFile>(MEMORY_SEED_PATH)) : fallback;
  const runtime = safeExistsSync(MEMORY_RUNTIME_PATH)
    ? validateIntentContractMemory(parseJson<IntentContractMemoryFile>(MEMORY_RUNTIME_PATH))
    : fallback;

  const mergedByKey = new Map<string, IntentContractMemoryEntry>();
  for (const entry of seed.entries) {
    mergedByKey.set(memoryEntryKey(entry), entry);
  }
  for (const entry of runtime.entries) {
    // Runtime memory overrides seed memory for the same intent-contract pair.
    mergedByKey.set(memoryEntryKey(entry), entry);
  }
  return { version: runtime.version || seed.version || '1.0.0', entries: Array.from(mergedByKey.values()) };
}

export function saveIntentContractMemory(memory: IntentContractMemoryFile): void {
  validateIntentContractMemory(memory);
  safeWriteFile(MEMORY_RUNTIME_PATH, JSON.stringify(memory, null, 2));
}

export function loadIntentContractSelectionPolicy(): IntentContractSelectionPolicy {
  const parsed = parseJson<IntentContractSelectionPolicy>(POLICY_PATH);
  const validate = ensurePolicyValidator();
  if (!validate(parsed)) {
    const errors = (validate.errors || []).map((e) => `${e.instancePath || '/'} ${e.message || 'schema violation'}`).join('; ');
    throw new Error(`Invalid intent-contract-selection-policy: ${errors}`);
  }
  return parsed;
}

export function resolveIntentContractMemoryPaths(): { seed: string; runtime: string } {
  return { seed: MEMORY_SEED_PATH, runtime: MEMORY_RUNTIME_PATH };
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

export function selectContractCandidates(intentId: string, maxCandidates = 3): ContractCandidate[] {
  const policy = loadIntentContractSelectionPolicy();
  const memory = loadIntentContractMemory();
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
  if (defaults && !merged.some((item) => item.contract_ref.kind === defaults.contract_ref.kind && item.contract_ref.ref === defaults.contract_ref.ref)) {
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
  context_fingerprint?: IntentContractMemoryEntry['context_fingerprint'];
}): IntentContractMemoryEntry {
  const memory = loadIntentContractMemory();
  const idx = memory.entries.findIndex((entry) =>
    entry.intent_id === input.intent_id &&
    entry.contract_ref.kind === input.contract_ref.kind &&
    entry.contract_ref.ref === input.contract_ref.ref,
  );

  if (idx < 0) {
    const created: IntentContractMemoryEntry = {
      intent_id: input.intent_id,
      context_fingerprint: input.context_fingerprint || {},
      contract_ref: input.contract_ref,
      execution_shape: input.execution_shape,
      success_rate: input.success ? 1 : 0,
      sample_count: 1,
      last_seen: new Date().toISOString(),
      ...(input.error ? { last_error: input.error } : {}),
    };
    memory.entries.push(created);
    saveIntentContractMemory(memory);
    return created;
  }

  const prev = memory.entries[idx];
  const nextCount = prev.sample_count + 1;
  const nextRate = (prev.success_rate * prev.sample_count + (input.success ? 1 : 0)) / nextCount;
  const updated: IntentContractMemoryEntry = {
    ...prev,
    execution_shape: input.execution_shape,
    context_fingerprint: input.context_fingerprint || prev.context_fingerprint,
    sample_count: nextCount,
    success_rate: Number(nextRate.toFixed(4)),
    last_seen: new Date().toISOString(),
    last_error: input.success ? undefined : input.error || prev.last_error,
  };
  memory.entries[idx] = updated;
  saveIntentContractMemory(memory);
  return updated;
}
