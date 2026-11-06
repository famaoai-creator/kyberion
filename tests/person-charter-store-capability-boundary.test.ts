import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the person charter store grant is module-private. Only the charter registry
// and the external-operation store open a store access; tier-guard asks the pure
// predicate while the dedicated role still exists. The installed owner binding is
// the trusted embedding seam (it confers no I/O), re-exported by
// external-operation-runtime for the installed runtimes.
describeStoreGrantBoundary('Person charter store grant trusted import boundary', {
  implementation: 'libs/core/governance/person-charter-runtime.ts',
  issuers: new Map([
    ['withPersonCharterStoreAccess', ['libs/core/governance/accountability-charter-registry.ts']],
    ['withPersonExternalReservationAccess', ['libs/core/governance/external-operation-store.ts']],
  ]),
  consumers: new Map([
    [
      'libs/core/governance/accountability-charter-registry.ts',
      ['currentInstalledPersonCharterRuntime', 'withPersonCharterStoreAccess'],
    ],
    [
      'libs/core/governance/external-operation-store.ts',
      ['currentInstalledPersonCharterRuntime', 'withPersonExternalReservationAccess'],
    ],
    ['libs/core/governance/external-operation-runtime.ts', ['withInstalledPersonCharterRuntime']],
    ['libs/core/tier-guard.ts', ['personCharterResourceAccessAllowed']],
  ]),
});
