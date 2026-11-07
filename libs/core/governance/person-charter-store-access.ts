/**
 * Governed facade of the person charter store grant (G2 of the store-catalog
 * guard design): the charter registry and the external-operation store open a
 * synchronous store access only through here (import boundary test
 * tests/person-charter-store-capability-boundary.test.ts).
 *
 * The grant is the authority for the I/O it covers (no store role). Who may issue
 * it is unchanged: the rule that bounded assuming the former shared core role
 * (RA-02, role-assumption-policy `shared_core_roles`) applies to the issuance right
 * `person_charter_store`; in an installation whose policy does not name it (it
 * predates the store) the grant admits no I/O until the installation migration.
 * While it is active the caller keeps its own role and persona and runs unbound
 * (project-scope tenant, no organization), as the role assumption bound it.
 */
import {
  assertStoreGrantIssuanceAllowed,
  isStoreGrantIssuanceRightRegistered,
} from '../authority.js';
import { currentExecutionScope, runInExecutionScope } from '../foundation/execution-scope.js';
import {
  PERSON_CHARTER_GRANT_ISSUANCE_RIGHT,
  withPersonCharterStoreAccess,
  withPersonExternalReservationAccess,
} from './person-charter-runtime.js';

function asUnboundCaller<T>(action: () => T): T {
  assertStoreGrantIssuanceAllowed(PERSON_CHARTER_GRANT_ISSUANCE_RIGHT);
  const {
    tenantCleared: _cleared,
    organizationId: _organization,
    tenantSlug: _tenant,
    ...current
  } = currentExecutionScope() ?? { tenantBound: false };
  return runInExecutionScope({ ...current, tenantBound: false }, action);
}

/** One synchronous, exact person charter registry access inside the installed owner binding. */
export function withPersonCharterRegistryAccess<T>(
  read: readonly string[],
  write: readonly string[],
  action: () => T
): T {
  const authorizes = isStoreGrantIssuanceRightRegistered(PERSON_CHARTER_GRANT_ISSUANCE_RIGHT);
  return withPersonCharterStoreAccess(read, write, authorizes, () => asUnboundCaller(action));
}

/** One synchronous canonical personal reservation write inside the installed owner binding. */
export function withPersonReservationAccess<T>(file: string, action: () => T): T {
  const authorizes = isStoreGrantIssuanceRightRegistered(PERSON_CHARTER_GRANT_ISSUANCE_RIGHT);
  return withPersonExternalReservationAccess(file, authorizes, () => asUnboundCaller(action));
}
