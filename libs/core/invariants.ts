/**
 * DH-06: module-attributed runtime invariants.
 *
 * An invariant is intentionally small and synchronous.  The registry does
 * not become a second policy engine: it gives a failing assertion a stable
 * module owner and makes the set of runtime/documented invariants inspectable
 * by CI.  Providers and plugins may add entries, but duplicate ids are never
 * last-wins.
 */

export type InvariantEnforcement = 'runtime' | 'documented';

export interface ModuleInvariant {
  module: string;
  id: string;
  description: string;
  enforcement: InvariantEnforcement;
  /** Required for runtime invariants; documented entries explain the gap. */
  check?: (facts: unknown) => boolean;
  reason?: string;
}

const invariants = new Map<string, ModuleInvariant>();

function invariantKey(moduleName: string, id: string): string {
  const module = moduleName.trim();
  const name = id.trim();
  if (!module || !name) throw new Error('[INVARIANT_CONFIG] module and id are required');
  return `${module}:${name}`;
}

export function registerModuleInvariant(invariant: ModuleInvariant): () => void {
  const key = invariantKey(invariant.module, invariant.id);
  if (!invariant.description.trim()) {
    throw new Error(`[INVARIANT_CONFIG] description is required for ${key}`);
  }
  if (invariant.enforcement === 'runtime' && !invariant.check) {
    throw new Error(`[INVARIANT_CONFIG] runtime invariant ${key} requires a check`);
  }
  if (
    invariant.enforcement === 'documented' &&
    !invariant.reason?.startsWith('No runtime invariant:')
  ) {
    throw new Error(
      `[INVARIANT_CONFIG] documented invariant ${key} requires a reason beginning with "No runtime invariant:"`
    );
  }
  if (invariants.has(key)) throw new Error(`[INVARIANT_CONFIG] duplicate invariant: ${key}`);
  const normalized = { ...invariant, module: invariant.module.trim(), id: invariant.id.trim() };
  invariants.set(key, normalized);
  return () => {
    if (invariants.get(key) === normalized) invariants.delete(key);
  };
}

export function listModuleInvariants(): readonly ModuleInvariant[] {
  return [...invariants.values()].sort((left, right) =>
    `${left.module}:${left.id}`.localeCompare(`${right.module}:${right.id}`)
  );
}

export function getModuleInvariant(moduleName: string, id: string): ModuleInvariant | undefined {
  return invariants.get(invariantKey(moduleName, id));
}

/** Assert a runtime invariant and attribute failures to the owning module. */
export function assertModuleInvariant(moduleName: string, id: string, facts: unknown): void {
  const key = invariantKey(moduleName, id);
  const invariant = invariants.get(key);
  if (!invariant) throw new Error(`[INVARIANT_CONFIG] invariant is not registered: ${key}`);
  if (invariant.enforcement !== 'runtime' || !invariant.check) return;
  let satisfied = false;
  try {
    satisfied = invariant.check(facts);
  } catch {
    satisfied = false;
  }
  if (!satisfied) {
    throw new Error(
      `[INVARIANT_VIOLATION] invariant "${invariant.id}" violated by "${invariant.module}": ${invariant.description}`
    );
  }
}

const DEFAULT_INVARIANTS: ModuleInvariant[] = [
  {
    module: 'op-preflight',
    id: 'decision-domain',
    description: 'preflight decisions are restricted to allow, block, or ask',
    enforcement: 'runtime',
    check: (facts) =>
      !!facts &&
      typeof facts === 'object' &&
      ['allow', 'block', 'ask'].includes((facts as { decision?: unknown }).decision as string),
  },
  {
    module: 'op-preflight',
    id: 'input-record',
    description: 'preflight output input is a record and never an opaque replacement',
    enforcement: 'runtime',
    check: (facts) => {
      const input = (facts as { input?: unknown } | null)?.input;
      return !!input && typeof input === 'object' && !Array.isArray(input);
    },
  },
  {
    module: 'seam',
    id: 'provider-metadata',
    description: 'every seam provider has an explicit provenance label',
    enforcement: 'runtime',
    check: (facts) => {
      const metadata = (facts as { metadata?: unknown } | null)?.metadata;
      const provenance = (metadata as { provenance?: unknown } | null)?.provenance;
      return ['builtin', 'plugin', 'tenant-overlay', 'generated'].includes(provenance as string);
    },
  },
  {
    module: 'lifecycle-hook-engine',
    id: 'outcome-shape',
    description:
      'lifecycle outcomes expose disposition, block state, bounded reason/context arrays, and patch object',
    enforcement: 'runtime',
    check: (facts) => {
      const outcome = facts as {
        blocked?: unknown;
        decision?: unknown;
        asked?: unknown;
        reasons?: unknown;
        additionalContext?: unknown;
        resultPatch?: unknown;
      };
      return (
        typeof outcome?.blocked === 'boolean' &&
        ['allow', 'ask', 'block'].includes(outcome?.decision as string) &&
        typeof outcome?.asked === 'boolean' &&
        Array.isArray(outcome.reasons) &&
        Array.isArray(outcome.additionalContext) &&
        !!outcome.resultPatch &&
        typeof outcome.resultPatch === 'object' &&
        !Array.isArray(outcome.resultPatch)
      );
    },
  },
  {
    module: 'reasoning-provider-registry',
    id: 'prompt-reconstruction',
    description: 'model-visible prompt fragments have a reconstructable durable log',
    enforcement: 'documented',
    reason: 'No runtime invariant: full prompt-to-journal reconstruction is coupled to PI-05.',
  },
  {
    module: 'prompt-visibility-ledger',
    id: 'record-shape',
    description: 'prompt visibility records contain metadata only and never raw prompt content',
    enforcement: 'runtime',
    check: (facts) => {
      const raw =
        facts && typeof facts === 'object' && !Array.isArray(facts)
          ? (facts as Record<string, unknown>)
          : {};
      const record = raw as {
        version?: unknown;
        record_id?: unknown;
        ts?: unknown;
        mission_id?: unknown;
        source?: unknown;
        form?: unknown;
        content_hash?: unknown;
        content_length?: unknown;
        knowledge_refs?: unknown;
      };
      return (
        record?.version === 1 &&
        typeof record.record_id === 'string' &&
        record.record_id.length > 0 &&
        typeof record.ts === 'string' &&
        typeof record.mission_id === 'string' &&
        record.mission_id.length > 0 &&
        typeof record.source === 'string' &&
        record.source.length > 0 &&
        typeof record.form === 'string' &&
        record.form.length > 0 &&
        typeof record.content_hash === 'string' &&
        /^[a-f0-9]{64}$/u.test(record.content_hash) &&
        Number.isInteger(record.content_length) &&
        Number(record.content_length) >= 0 &&
        Array.isArray(record.knowledge_refs) &&
        record.knowledge_refs.every((ref) => typeof ref === 'string') &&
        raw.content === undefined &&
        raw.prompt === undefined &&
        raw.text === undefined &&
        (raw.context_pack_id === undefined || typeof raw.context_pack_id === 'string') &&
        (raw.task_id === undefined || typeof raw.task_id === 'string')
      );
    },
  },
];

function installDefaultInvariants(): void {
  for (const invariant of DEFAULT_INVARIANTS) {
    if (!invariants.has(`${invariant.module}:${invariant.id}`)) {
      invariants.set(`${invariant.module}:${invariant.id}`, invariant);
    }
  }
}

installDefaultInvariants();

/** Test seam; defaults are restored so production contracts remain present. */
export function resetModuleInvariantsForTests(): void {
  invariants.clear();
  installDefaultInvariants();
}
