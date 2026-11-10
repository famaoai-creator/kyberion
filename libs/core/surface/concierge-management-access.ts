/**
 * Governed facade of the Concierge management grant (G2 of the store-catalog guard design): the
 * Web management mediators (surface management, organization people, information assets) open
 * their exact request ceiling only through here (import boundary test
 * tests/concierge-management-capability-boundary.test.ts).
 *
 * One call: the server-created exact resource ceiling, the Concierge-only issuance right checked
 * the way assuming the role was bounded (RA-02, role-assumption-policy
 * `system_roles.concierge.may_assume`), the management store grant (S4: a declared store grant,
 * not a role; the reader is an audited disclosure, the writer is issued per write) bound to the
 * request's tenant and organization, and the grant bound to that scope. A request with writes is a
 * writer and needs its organization; one without is a read-only reader. The grant lives exactly as
 * long as the call: the synchronous form until its callback returns, the asynchronous form until
 * the awaited body settles.
 */
import {
  assertStoreGrantIssuanceAllowed,
  recordStoreGrantDisclosure,
  withStoreGrant,
  withStoreGrantAsync,
} from '../authority.js';
import type { ExecutionIdentityBinding } from '../foundation/execution-scope.js';
import {
  CONCIERGE_MANAGEMENT_ISSUANCE_RIGHTS,
  withConciergeManagementGrant,
  withConciergeManagementGrantAsync,
  type ConciergeManagementGrantKind,
} from '../foundation/concierge-management-capability.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';

/** A server-built exact request ceiling (repository-relative paths; never client input). */
export interface ConciergeManagementRequest {
  tenantSlug: string;
  organizationId?: string;
  projectId?: string;
  reads: readonly string[];
  writes: readonly string[];
  mkdir: readonly string[];
  metadata?: readonly string[];
  /** A writer even without writes (default: a request with writes is a writer). */
  writer?: boolean;
  /** Execution identity bound with the assumption (e.g. the information asset project). */
  identity?: ExecutionIdentityBinding;
}

function prepare(request: ConciergeManagementRequest): {
  kind: ConciergeManagementGrantKind;
  role: string;
  enter: <T>(run: () => T) => T;
  disclosureReceipt?: object;
} {
  const kind: ConciergeManagementGrantKind =
    (request.writer ?? request.writes.length > 0) ? 'writer' : 'reader';
  const role = CONCIERGE_MANAGEMENT_ISSUANCE_RIGHTS[kind];
  assertStoreGrantIssuanceAllowed(role);
  // S4 (owner decision): a management read is an audited disclosure. It is recorded
  // here, before the exact ceiling is entered, and the grant consumes the receipt.
  const disclosureReceipt =
    kind === 'reader'
      ? recordStoreGrantDisclosure(role, {
          tenantSlug: request.tenantSlug,
          organizationId: request.organizationId,
        })
      : undefined;
  const ceiling = {
    tenantSlug: request.tenantSlug,
    ...(request.organizationId ? { organizationId: request.organizationId } : {}),
    ...(request.projectId ? { projectId: request.projectId } : {}),
    readExact: [...request.reads],
    writeExact: [...request.writes],
    ...(request.metadata ? { metadataExact: [...request.metadata] } : {}),
    mkdirExact: [...request.mkdir],
    allowProductKnowledgeRead: true,
  };
  return {
    kind,
    role,
    enter: (run) => runInResourceAccessScope(ceiling, run),
    ...(disclosureReceipt ? { disclosureReceipt } : {}),
  };
}

/** One synchronous exact management access; the grant ends when `action` returns. */
export function withConciergeManagementAccess<T>(
  request: ConciergeManagementRequest,
  action: () => T
): T {
  const { kind, role, enter, disclosureReceipt } = prepare(request);
  return enter(() =>
    withStoreGrant(
      // A literal name union keeps the RN-03 reachability analysis bounded.
      role === 'concierge_management_writer'
        ? 'concierge_management_writer'
        : 'concierge_management_reader',
      () => withConciergeManagementGrant(kind, action),
      {
        tenantSlug: request.tenantSlug,
        organizationId: request.organizationId,
        identity: request.identity,
        disclosureReceipt,
      }
    )
  );
}

/** One asynchronous exact management access; the grant ends when the awaited body settles. */
export async function withConciergeManagementAccessAsync<T>(
  request: ConciergeManagementRequest,
  action: () => Promise<T> | T
): Promise<T> {
  const { kind, role, enter, disclosureReceipt } = prepare(request);
  return enter(() =>
    withStoreGrantAsync(
      role === 'concierge_management_writer'
        ? 'concierge_management_writer'
        : 'concierge_management_reader',
      () => withConciergeManagementGrantAsync(kind, action),
      {
        tenantSlug: request.tenantSlug,
        organizationId: request.organizationId,
        identity: request.identity,
        disclosureReceipt,
      }
    )
  );
}
