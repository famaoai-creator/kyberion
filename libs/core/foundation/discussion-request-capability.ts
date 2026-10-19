import * as path from 'node:path';
import type { ResourceAccessScope } from './resource-access-scope.js';
import { isValidTenantSlug } from './scope.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from './runtime-state-roots.js';

export const DISCUSSION_REQUEST_STORAGE_ROLE = 'discussion_request_store';
const ROOT = PARTITIONED_RUNTIME_STATE_ROOTS.discussion_create_requests;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** A capability is limited to the two immutable records of one scoped request. */
export function discussionRequestCapability(
  directory: string,
  tenant: string,
  write: boolean
): ResourceAccessScope {
  const prefix = ROOT + '/confidential/' + tenant + '/by-actor/';
  const parts = directory.startsWith(prefix) ? directory.slice(prefix.length).split('/') : [];
  if (
    !isValidTenantSlug(tenant) ||
    path.posix.normalize(directory) !== directory ||
    parts.length !== 3 ||
    !HASH.test(parts[0] ?? '') ||
    !HASH.test(parts[1] ?? '') ||
    !UUID.test(parts[2] ?? '')
  )
    throw new Error('[RESOURCE_SCOPE_INVALID] Invalid Discussion request capability');
  const files = [directory + '/reservation.json', directory + '/receipt.json'];
  const mkdir: string[] = [];
  if (write)
    for (
      let dir = directory;
      dir === ROOT || dir.startsWith(ROOT + '/');
      dir = path.posix.dirname(dir)
    )
      mkdir.push(dir);
  return {
    tenantSlug: tenant,
    readExact: files,
    writeExact: write ? files : [],
    mkdirExact: mkdir,
  };
}

export function isDiscussionRequestCapability(scope: ResourceAccessScope | undefined): boolean {
  if (
    !scope ||
    scope.readExact.length !== 2 ||
    (scope.metadataExact?.length ?? 0) !== 0 ||
    scope.allowProductKnowledgeRead === true ||
    scope.organizationId ||
    scope.projectId
  )
    return false;
  try {
    const expected = discussionRequestCapability(
      path.posix.dirname(scope.readExact[0]!),
      scope.tenantSlug,
      scope.writeExact.length > 0
    );
    const same = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && a.every((item, i) => item === b[i]);
    return (
      same(scope.readExact, expected.readExact) &&
      same(scope.writeExact, expected.writeExact) &&
      same(scope.mkdirExact, expected.mkdirExact)
    );
  } catch {
    return false;
  }
}
