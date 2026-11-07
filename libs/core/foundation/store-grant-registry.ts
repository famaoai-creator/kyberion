/**
 * G3 of the store-catalog guard design: the one place tier-guard asks about live
 * store grants, so the guard no longer imports each capability module.
 *
 * Every store grant (an issuer-private grant, window or ceiling of one governed
 * store facade) registers its rules here when its own module is evaluated. A
 * grant can only be live after its module has been evaluated — its state is
 * private to that module — so a rule that is not registered belongs to a grant
 * that cannot be live, and the guard skips it exactly as the grant's own
 * predicate would have answered "no grant". Rules that must hold whether or not
 * a grant module is loaded (deny-only role narrowings, a path that only a grant
 * may reach) stay in the guard and ask `storeGrantRule` with a fail-closed
 * default.
 *
 * Registration is sealed: only the ids listed in `STORE_GRANT_IDS` may register,
 * each exactly once, and only the capability modules named by the import
 * boundary test (`tests/store-grant-registry-boundary.test.ts`) may import
 * `registerStoreGrant`. The registry is not a public subpath of `@agent/core`.
 * Possession of the registry grants nothing: every rule still consults its own
 * module-private grant state.
 */
import type { ResourceAccessOperation, ResourceAccessScope } from './resource-access-scope.js';

/** The store grants tier-guard knows, in evaluation order. */
export const STORE_GRANT_IDS = [
  'asset-derivation',
  'memory-provenance',
  'pr-publication',
  'person-charter',
  'personal-approval',
  'task-source-workspace',
  'customer-decision-invite',
  'customer-decision-consumer',
  'customer-decision-milestone',
  'dot-result',
  'discussion-request',
  'autonomy-learning',
  'pipeline-journal',
  'credential-material',
  'concierge-management',
] as const;
export type StoreGrantId = (typeof STORE_GRANT_IDS)[number];

/** Content of a whole-file write (secure-io `safeWriteFile`). */
export type StoreGrantWriteContent = string | Buffer;

export interface StoreGrantNarrowingInput {
  relativePath: string;
  operation: ResourceAccessOperation;
  /** Literal and canonical candidates of the path (tier-guard `denyCandidatePaths`, computed on demand). */
  candidates(): readonly string[];
  scope: ResourceAccessScope | undefined;
  content: StoreGrantWriteContent | undefined;
  /** The guard's own raw read of a repo-relative file (undefined when absent). */
  readRepoFile: (repoRelative: string) => string | undefined;
}

export interface StoreGrantRule {
  id: StoreGrantId;
  /** Is a grant of this store live in the current context? */
  active?(): boolean;
  /** The live grant's kind, for a store whose grant has kinds. */
  kind?(): string | undefined;
  /** Is the live grant itself the authority for this I/O? */
  authorizes?(
    target: string,
    operation: ResourceAccessOperation,
    context: { rootDir: string; scope: ResourceAccessScope | undefined }
  ): boolean;
  /** Deny-only narrowing of every I/O made while the grant is live: the refusal reason, or null. */
  narrowing?(input: StoreGrantNarrowingInput): string | null;
  /** May a guarded path that only this grant reaches be used for this I/O? */
  pathAllowed?(target: string, operation: ResourceAccessOperation): boolean;
  /**
   * Structural tier-container mkdir: true/false decides it for the live grant,
   * undefined leaves it to the guard's other rules.
   */
  structuralMkdir?(
    relativePath: string,
    protectedPrefix: string,
    tenantSlug: string | undefined,
    scope: ResourceAccessScope | undefined
  ): boolean | 'shared-checks' | undefined;
}

const KNOWN: ReadonlySet<string> = new Set(STORE_GRANT_IDS);
const rules = new Map<StoreGrantId, Readonly<StoreGrantRule>>();

/** Register a store grant's rules from its own module (sealed: known id, once). */
export function registerStoreGrant(rule: StoreGrantRule): void {
  if (!KNOWN.has(rule.id))
    throw new Error(`[STORE_GRANT_UNKNOWN] '${rule.id}' is not a store grant`);
  if (rules.has(rule.id))
    throw new Error(`[STORE_GRANT_DUPLICATE] '${rule.id}' is already registered`);
  rules.set(rule.id, Object.freeze({ ...rule }));
}

/** The registered rules of one store grant (undefined: its module is not loaded, so no grant is live). */
export function storeGrantRule(id: StoreGrantId): Readonly<StoreGrantRule> | undefined {
  return rules.get(id);
}

/** Registered rules in evaluation order (the order of `STORE_GRANT_IDS`). */
export function storeGrantRules(): Readonly<StoreGrantRule>[] {
  const out: Readonly<StoreGrantRule>[] = [];
  for (const id of STORE_GRANT_IDS) {
    const rule = rules.get(id);
    if (rule) out.push(rule);
  }
  return out;
}

export function storeGrantActive(id: StoreGrantId): boolean {
  return rules.get(id)?.active?.() === true;
}

/** Does any live store grant authorize this I/O? */
export function storeGrantAuthorizes(
  target: string,
  operation: ResourceAccessOperation,
  context: { rootDir: string; scope: ResourceAccessScope | undefined }
): boolean {
  return storeGrantRules().some((rule) => rule.authorizes?.(target, operation, context) === true);
}

/** The first refusal of the live grants' narrowings among `ids`, in registry order. */
export function storeGrantNarrowingDenial(
  ids: readonly StoreGrantId[],
  input: StoreGrantNarrowingInput
): string | null {
  for (const id of STORE_GRANT_IDS) {
    if (!ids.includes(id)) continue;
    const reason = rules.get(id)?.narrowing?.(input);
    if (reason) return reason;
  }
  return null;
}
