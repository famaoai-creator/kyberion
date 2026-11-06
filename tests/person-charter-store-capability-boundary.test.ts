import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the person charter store grant is module-private and is itself the authority.
// Only the governed facade (person-charter-store-access.ts) issues it, and only the
// charter registry and the external-operation store call the facade; tier-guard
// narrows every I/O inside it and the store-grant table asks the authority
// predicate. The installed owner binding is the trusted embedding seam (it confers
// no I/O), re-exported by external-operation-runtime for the installed runtimes.
describeStoreGrantBoundary('Person charter store grant trusted import boundary', {
  implementation: 'libs/core/governance/person-charter-runtime.ts',
  issuers: new Map([
    ['withPersonCharterStoreAccess', ['libs/core/governance/person-charter-store-access.ts']],
    [
      'withPersonExternalReservationAccess',
      ['libs/core/governance/person-charter-store-access.ts'],
    ],
  ]),
  consumers: new Map([
    [
      'libs/core/governance/person-charter-store-access.ts',
      [
        'PERSON_CHARTER_GRANT_ISSUANCE_RIGHT',
        'withPersonCharterStoreAccess',
        'withPersonExternalReservationAccess',
      ],
    ],
    [
      'libs/core/governance/accountability-charter-registry.ts',
      ['currentInstalledPersonCharterRuntime'],
    ],
    ['libs/core/governance/external-operation-store.ts', ['currentInstalledPersonCharterRuntime']],
    ['libs/core/governance/external-operation-runtime.ts', ['withInstalledPersonCharterRuntime']],
    ['libs/core/tier-guard.ts', ['personCharterIoAllowed', 'personCharterStoreGrantActive']],
    ['libs/core/tier-guard-store-grants.ts', ['personCharterGrantAuthorizes']],
  ]),
});

// The facade itself: only the charter registry and the external-operation store open it.
describeStoreGrantBoundary('Person charter store facade trusted import boundary', {
  implementation: 'libs/core/governance/person-charter-store-access.ts',
  issuers: new Map([
    [
      'withPersonCharterRegistryAccess',
      ['libs/core/governance/accountability-charter-registry.ts'],
    ],
    ['withPersonReservationAccess', ['libs/core/governance/external-operation-store.ts']],
  ]),
  consumers: new Map([
    [
      'libs/core/governance/accountability-charter-registry.ts',
      ['withPersonCharterRegistryAccess'],
    ],
    ['libs/core/governance/external-operation-store.ts', ['withPersonReservationAccess']],
  ]),
});
