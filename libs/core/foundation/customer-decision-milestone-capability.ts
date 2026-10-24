import * as path from 'node:path';
import type { ResourceAccessScope } from './resource-access-scope.js';
import { getProcessEnv } from './process-env.js';
import { isValidTenantSlug } from './scope.js';

/**
 * Narrow store role for CD-10 bolt-review milestones
 * (libs/core/mission/mission-bolt-review.ts). `startMission` assumes it to mark
 * the `bolt-after:<MISSION>` milestone passed on the open bolt-review agendas
 * of the mission's decision case: it may list `agendas/`, read named agenda
 * files and write exactly one agenda file per operation. Never the ledger,
 * receipts, switches, consumers, attachments, invites or customers/.
 */
export const CUSTOMER_DECISION_MILESTONE_STORE_ROLE = 'customer_decision_milestone_store';

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

export function isCustomerDecisionMilestoneCapability(
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
