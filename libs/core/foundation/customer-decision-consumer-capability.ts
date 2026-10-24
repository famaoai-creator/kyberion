import * as path from 'node:path';
import type { ResourceAccessScope } from './resource-access-scope.js';
import { getProcessEnv } from './process-env.js';
import { isValidTenantSlug } from './scope.js';

/**
 * Narrow store role for CD-09 task decision locks
 * (`knowledge/confidential/<tenant>/decisions/<case>/consumers/<consumer>.json`,
 * libs/core/mission/mission-decision-lock.ts). Mission processes assume it at
 * task boundaries instead of the full `decision_ledger` role: it may read the
 * case's ledger, switches and agendas and write exactly one consumer lock.
 */
export const CUSTOMER_DECISION_CONSUMER_STORE_ROLE = 'customer_decision_consumer_store';

const CASE_DIR =
  /^knowledge\/confidential\/([a-z][a-z0-9-]{1,30})\/decisions\/[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/u;
/** Hermetic tests keep a case in a scratch directory (`{ dir }` locations). */
const SANDBOX_CASE_DIR = /^active\/shared\/tmp\/[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/u;
const AGENDA_FILE = /^agendas\/agd-[A-Za-z0-9][A-Za-z0-9_-]{3,80}\.json$/u;
const CONSUMER_FILE =
  /^consumers\/mission-[A-Za-z0-9][A-Za-z0-9_-]{0,100}\.[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.json$/u;
const READABLE = new Set(['decisions.jsonl', 'switches.jsonl', 'agendas', 'consumers']);

export interface CustomerDecisionConsumerAccess {
  /** Case-relative paths to read: the ledger, switches, the two listings, agenda and consumer files. */
  read: readonly string[];
  /** Case-relative consumer lock to write (`consumers/<consumer>.json`). */
  write?: string;
  /**
   * A task's own boundary (pin / reconcile / proposals): the only consumer
   * lock it may read or write is `consumers/<owner>.json`, and it may not list
   * `consumers/`. Omitted only by the response / confirm sweep, which
   * reconciles every consumer of the case.
   */
  owner?: string;
}

/** The tenant's decisions root: existence checks only (no reads, no writes). */
const DECISIONS_ROOT = /^knowledge\/confidential\/([a-z][a-z0-9-]{1,30})\/decisions$/u;

/** The repo-relative decisions root of a tenant (`knowledge/confidential/<tenant>/decisions`). */
export function customerDecisionsRootDir(tenantSlug: string): string {
  return `knowledge/confidential/${tenantSlug}/decisions`;
}

function caseDirValid(tenantSlug: string, caseDir: string): boolean {
  if (path.posix.normalize(caseDir) !== caseDir) return false;
  const match = CASE_DIR.exec(caseDir);
  if (match) return match[1] === tenantSlug;
  return Boolean(getProcessEnv('VITEST')) && SANDBOX_CASE_DIR.test(caseDir);
}

function readable(relative: string): boolean {
  return READABLE.has(relative) || AGENDA_FILE.test(relative) || CONSUMER_FILE.test(relative);
}

/**
 * The deny-only ceiling for one consumer-lock operation on one case directory
 * (repo-relative). Reads: only the named ledger / switches / listing / agenda /
 * consumer paths. Writes: at most one consumer lock and its `consumers/`
 * directory. Never the ledger, an agenda, a receipt, the actor registry or
 * anything outside the tenant's own case.
 */
export function customerDecisionConsumerCapability(
  tenantSlug: string,
  caseDir: string,
  access: CustomerDecisionConsumerAccess
): ResourceAccessScope {
  const root = caseDir.match(DECISIONS_ROOT);
  if (root) {
    // Existence of the tenant's decisions root only: a mission with no case
    // at all is left alone after one stat.
    if (root[1] !== tenantSlug || access.read.length > 0 || access.write)
      throw new Error('[RESOURCE_SCOPE_INVALID] Invalid customer decision consumer path');
    return {
      tenantSlug,
      metadataExact: [caseDir],
      readExact: [],
      writeExact: [],
      mkdirExact: [],
      allowProductKnowledgeRead: true,
    };
  }
  if (!isValidTenantSlug(tenantSlug) || !caseDirValid(tenantSlug, caseDir))
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid customer decision consumer case');
  if (!access.read.every(readable) || (access.write && !CONSUMER_FILE.test(access.write)))
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid customer decision consumer path');
  if (access.owner !== undefined) {
    const own = `consumers/${access.owner}.json`;
    const foreign = (relative: string) =>
      relative === 'consumers' || (CONSUMER_FILE.test(relative) && relative !== own);
    if (
      !CONSUMER_FILE.test(own) ||
      access.read.some(foreign) ||
      (access.write && foreign(access.write))
    )
      throw new Error(
        '[RESOURCE_SCOPE_INVALID] A task boundary may only touch its own customer decision consumer lock'
      );
  }
  const inCase = (relative: string) => `${caseDir}/${relative}`;
  const read = [...new Set([...access.read, ...(access.write ? [access.write] : [])])].sort();
  return {
    tenantSlug,
    metadataExact: [caseDir],
    readExact: read.map(inCase),
    writeExact: access.write ? [inCase(access.write)] : [],
    mkdirExact: access.write ? [inCase('consumers')] : [],
    allowProductKnowledgeRead: true,
  };
}

export function isCustomerDecisionConsumerCapability(
  scope: ResourceAccessScope | undefined
): boolean {
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
    const expected = customerDecisionConsumerCapability(scope.tenantSlug, caseDir, {
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
