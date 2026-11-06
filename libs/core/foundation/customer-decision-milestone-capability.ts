import * as path from 'node:path';
import {
  createSynchronousResourceGrantIssuer,
  currentResourceAccessScope,
  decideResourceAccess,
  type ResourceAccessOperation,
  type ResourceAccessScope,
} from './resource-access-scope.js';
import { getProcessEnv } from './process-env.js';
import { isValidTenantSlug } from './scope.js';

/**
 * CD-10 bolt-review milestones (libs/core/mission/mission-bolt-review.ts).
 * `startMission` opens the exact milestone grant to mark the
 * `bolt-after:<MISSION>` milestone passed on the open bolt-review agendas of the
 * mission's decision case: it may list `agendas/`, read named agenda files and
 * write exactly one agenda file per operation, every write held to the
 * milestone-only content rule. Never the ledger, receipts, switches, consumers,
 * attachments, invites or customers/.
 *
 * G2: the live grant is itself the authority for the I/O it covers
 * (`customerDecisionMilestoneGrantAllows`); there is no store role. The former
 * role name is the grant's issuance right (role-assumption-policy
 * `shared_core_roles`, checked by authority.ts assertStoreGrantIssuanceAllowed);
 * it is not an assumable authority role.
 */
export const CUSTOMER_DECISION_MILESTONE_GRANT_ISSUANCE_RIGHT = 'customer_decision_milestone_store';

const CASE_DIR =
  /^knowledge\/confidential\/([a-z][a-z0-9-]{1,30})\/decisions\/[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u;
/** Hermetic tests keep a case in a scratch directory (`{ dir }` locations). */
const SANDBOX_CASE_DIR = /^active\/shared\/tmp\/[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/u;
const AGENDA_FILE = /^agendas\/agd-[A-Za-z0-9][A-Za-z0-9_-]{3,80}\.json$/u;

export interface CustomerDecisionMilestoneAccess {
  /** Case-relative paths to read: the `agendas` listing and agenda files. */
  read: readonly string[];
  /** Case-relative agenda file to write (`agendas/<agenda_id>.json`). */
  write?: string;
}

function caseDirValid(tenantSlug: string, caseDir: string): boolean {
  if (path.posix.normalize(caseDir) !== caseDir) return false;
  const match = CASE_DIR.exec(caseDir);
  if (match) return match[1] === tenantSlug;
  return Boolean(getProcessEnv('VITEST')) && SANDBOX_CASE_DIR.test(caseDir);
}

const readable = (relative: string) => relative === 'agendas' || AGENDA_FILE.test(relative);

/**
 * The deny-only ceiling for one milestone operation on one case directory
 * (repo-relative): reads of the named listing / agenda files, at most one
 * agenda write (and the `agendas/` directory guard a write passes through).
 */
export function customerDecisionMilestoneCapability(
  tenantSlug: string,
  caseDir: string,
  access: CustomerDecisionMilestoneAccess
): ResourceAccessScope {
  if (!isValidTenantSlug(tenantSlug) || !caseDirValid(tenantSlug, caseDir))
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid customer decision milestone case');
  if (!access.read.every(readable) || (access.write && !AGENDA_FILE.test(access.write)))
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid customer decision milestone path');
  const inCase = (relative: string) => `${caseDir}/${relative}`;
  const read = [...new Set([...access.read, ...(access.write ? [access.write] : [])])].sort();
  return {
    tenantSlug,
    metadataExact: [caseDir],
    readExact: read.map(inCase),
    writeExact: access.write ? [inCase(access.write)] : [],
    mkdirExact: access.write ? [inCase('agendas')] : [],
    allowProductKnowledgeRead: true,
  };
}

const grants = createSynchronousResourceGrantIssuer<
  Readonly<{ tenantSlug: string; caseDir: string }>
>('CUSTOMER_DECISION_MILESTONE_CAPABILITY');

/**
 * Internal synchronous issuer of one exact milestone ceiling (G2), import-restricted to
 * mission/mission-bolt-review.ts (boundary test
 * tests/customer-decision-milestone-capability-boundary.test.ts). The opaque grant exists only
 * while `internalFn` runs; a structural lookalike, copy or counterfeit resolves nothing.
 */
export function withCustomerDecisionMilestoneCapability<T>(
  tenantSlug: string,
  caseDir: string,
  access: CustomerDecisionMilestoneAccess,
  internalFn: () => T
): T {
  const scope = customerDecisionMilestoneCapability(tenantSlug, caseDir, access);
  return grants.run(Object.freeze({ tenantSlug, caseDir }), scope, internalFn);
}

/** Pure mandatory guard: only this issuer's live grant with a milestone ceiling resolves. */
export function isCustomerDecisionMilestoneCapability(
  scope: ResourceAccessScope | undefined
): boolean {
  return Boolean(grants.resolve(scope)) && isMilestoneCeiling(scope);
}

function isMilestoneCeiling(scope: ResourceAccessScope | undefined): boolean {
  if (
    !scope ||
    scope.organizationId ||
    scope.projectId ||
    scope.allowProductKnowledgeRead !== true ||
    scope.metadataExact?.length !== 1 ||
    scope.writeExact.length > 1
  )
    return false;
  const caseDir = scope.metadataExact[0]!;
  const prefix = `${caseDir}/`;
  const relative = (target: string) =>
    target.startsWith(prefix) ? target.slice(prefix.length) : '';
  try {
    const write = scope.writeExact[0] ? relative(scope.writeExact[0]) : undefined;
    const expected = customerDecisionMilestoneCapability(scope.tenantSlug, caseDir, {
      read: scope.readExact.map(relative),
      ...(write !== undefined ? { write } : {}),
    });
    return (
      JSON.stringify([...scope.readExact].sort()) === JSON.stringify(expected.readExact) &&
      JSON.stringify(scope.writeExact) === JSON.stringify(expected.writeExact) &&
      JSON.stringify(scope.mkdirExact) === JSON.stringify(expected.mkdirExact)
    );
  } catch {
    return false;
  }
}

/**
 * Stable JSON for value comparison (key order never makes two equal values
 * differ). Every own key is kept as data — a `"__proto__"` key from parsed
 * content is defined, never assigned, so it cannot drop out of the comparison.
 * Shared by the content-checked guards (milestone, consumer, invite revoke).
 */
export function caseRecordCanonicalJson(value: unknown): string {
  const sortKeys = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input && typeof input === 'object') {
      const sorted: Record<string, unknown> = Object.create(null);
      for (const key of Object.keys(input as Record<string, unknown>).sort())
        Object.defineProperty(sorted, key, {
          value: sortKeys((input as Record<string, unknown>)[key]),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      return sorted;
    }
    return input;
  };
  return JSON.stringify(sortKeys(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The guard-side content rule of a milestone store write (CD-10): the agenda
 * must already exist, and the new content may differ from it only by
 * milestones appended to `milestones_passed` and a new `updated_at`. Enforced
 * by the tier guard on every write the role makes through secure-io (the
 * store's own `writeAgenda` check is the friendly early refusal), so a process
 * that builds the capability itself cannot rewrite an agenda. Returns the
 * refusal reason, or null when the change is allowed.
 */
export function customerDecisionMilestoneWriteProblem(
  previous: unknown,
  next: unknown
): string | null {
  const refused = (why: string) => `[CUSTOMER_DECISION_MILESTONE_WRITE_REFUSED] ${why}`;
  const before = asRecord(previous);
  const after = asRecord(next);
  if (!before) return refused('the milestone store may only update an existing agenda');
  if (!after) return refused('the new agenda content is not a JSON object');
  const passed = (record: Record<string, unknown>) =>
    Array.isArray(record.milestones_passed) ? record.milestones_passed : [];
  const was = passed(before);
  const now = passed(after);
  if (
    (after.milestones_passed !== undefined && !Array.isArray(after.milestones_passed)) ||
    now.length <= was.length ||
    !was.every((milestone, index) => now[index] === milestone) ||
    !now.every((milestone) => typeof milestone === 'string')
  )
    return refused('the milestone store may only append to milestones_passed');
  const rest = (record: Record<string, unknown>) => {
    const { milestones_passed: _passed, updated_at: _updated, ...others } = record;
    void _passed;
    void _updated;
    return others;
  };
  if (caseRecordCanonicalJson(rest(before)) !== caseRecordCanonicalJson(rest(after)))
    return refused('the milestone store may change only milestones_passed and updated_at');
  return null;
}

/**
 * Does the live grant authorize this I/O? Only inside its exact ceiling and only where the former
 * `customer_decision_milestone_store` policy grant reached: under the tenant decisions root, and
 * the metadata of that root's ancestors (the role-policy metadata rule for a scoped role). Product
 * schema reads and the Vitest sandbox case stay with the caller's own policy, as under the role.
 */
export function customerDecisionMilestoneGrantAllows(
  target: string,
  operation: ResourceAccessOperation
): boolean {
  const scope = currentResourceAccessScope();
  if (!scope || !isCustomerDecisionMilestoneCapability(scope)) return false;
  const root = `knowledge/confidential/${scope.tenantSlug}/decisions`;
  const under = target === root || target.startsWith(root + '/');
  const ancestor = operation === 'metadata' && root.startsWith(target + '/');
  if (!under && !ancestor) return false;
  return decideResourceAccess(scope, target, operation).allowed;
}

/** Is a live milestone grant current (its writes are content-checked)? */
export function customerDecisionMilestoneGrantActive(): boolean {
  return isCustomerDecisionMilestoneCapability(currentResourceAccessScope());
}
