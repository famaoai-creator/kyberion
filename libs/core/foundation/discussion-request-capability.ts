/** Internal exact Discussion request receipt ceiling. Only the governed receipt facade may issue it. */
import * as path from 'node:path';
import {
  createSynchronousResourceGrantIssuer,
  type ResourceAccessScope,
} from './resource-access-scope.js';
import { isValidTenantSlug } from './scope.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from './runtime-state-roots.js';

export const DISCUSSION_REQUEST_STORAGE_ROLE = 'discussion_request_store';
const ROOT = PARTITIONED_RUNTIME_STATE_ROOTS.discussion_create_requests;
const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface DiscussionRequestBinding {
  /** Repository-relative request directory: `<root>/confidential/<tenant>/by-actor/<hash>/<hash>/<uuid>`. */
  directory: string;
  tenant: string;
  write: boolean;
}
const grants = createSynchronousResourceGrantIssuer<DiscussionRequestBinding>(
  'DISCUSSION_REQUEST_CAPABILITY'
);

/** The ceiling is limited to the two immutable records of one scoped request. */
function discussionRequestCeiling(
  directory: string,
  tenant: string,
  write: boolean
): ResourceAccessScope {
  const prefix = ROOT + '/confidential/' + tenant + '/by-actor/';
  const parts =
    typeof directory === 'string' && directory.startsWith(prefix)
      ? directory.slice(prefix.length).split('/')
      : [];
  if (
    typeof write !== 'boolean' ||
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

/**
 * Internal synchronous issuer, import-restricted to discussion/discussion-request-storage-scope.ts.
 * The opaque grant exists only while `internalFn` runs; a structural lookalike resolves nothing.
 */
export function withDiscussionRequestCapability<T>(
  input: DiscussionRequestBinding,
  internalFn: () => T
): T {
  const binding = Object.freeze({
    directory: input?.directory,
    tenant: input?.tenant,
    write: input?.write,
  });
  const scope = discussionRequestCeiling(binding.directory, binding.tenant, binding.write);
  return grants.run(binding, scope, internalFn);
}

/** Pure mandatory guard: only this issuer's live, exact grant resolves. */
export function isDiscussionRequestCapability(scope: ResourceAccessScope | undefined): boolean {
  const grant = grants.resolve(scope);
  if (!grant) return false;
  const live = grant.scope;
  if (
    (live.metadataExact?.length ?? 0) !== 0 ||
    (live.appendExact?.length ?? 0) !== 0 ||
    (live.namePrefixExact?.length ?? 0) !== 0 ||
    live.allowProductKnowledgeRead === true ||
    live.organizationId ||
    live.projectId
  )
    return false;
  try {
    const expected = discussionRequestCeiling(
      grant.binding.directory,
      grant.binding.tenant,
      grant.binding.write
    );
    const same = (a: readonly string[], b: readonly string[]) =>
      a.length === b.length && a.every((item, i) => item === b[i]);
    return (
      live.tenantSlug === expected.tenantSlug &&
      same(live.readExact, expected.readExact) &&
      same(live.writeExact, expected.writeExact) &&
      same(live.mkdirExact, expected.mkdirExact)
    );
  } catch {
    return false;
  }
}
