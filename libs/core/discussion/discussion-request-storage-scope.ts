import { withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import {
  discussionRequestCapability,
  DISCUSSION_REQUEST_STORAGE_ROLE,
} from '../foundation/discussion-request-capability.js';
import type { DiscussionScope } from './discussion-types.js';

/** Internal synchronous receipt I/O only. Caller first resolves authenticated actor and canonical scope.
 * The deny-only ceiling survives nested role assumptions; no room/model work runs inside it.
 */
export function withDiscussionRequestReceiptAccess<T>(
  input: { directory: string; scope: DiscussionScope; write: boolean },
  fn: () => T
): T {
  const tenant = input.scope.tenant_slug;
  if (!tenant || input.scope.tier !== 'confidential')
    throw new Error('[RESOURCE_SCOPE_INVALID] Select an existing tenant for Discussion recovery');
  const capability = discussionRequestCapability(
    pathResolver.toRepoRelative(input.directory),
    tenant,
    input.write
  );
  return runInResourceAccessScope(capability, () =>
    withExecutionContext(DISCUSSION_REQUEST_STORAGE_ROLE, fn, undefined, tenant)
  );
}
