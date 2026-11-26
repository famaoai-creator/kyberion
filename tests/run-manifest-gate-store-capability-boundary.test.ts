import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// pipeline-run-manifest-model §3.5: the run-manifest gate binding and store
// grant are module-private (the same shape as the PR publication grant). Only
// the gate runtime opens a binding — and only an admitting RunManifestSession
// calls it — and only the charter registry, the reservation store and the
// review writer of the external-operation runtime open a store access.
const capability = 'libs/core/foundation/run-manifest-gate-store-capability.ts';
const runtime = 'libs/core/governance/run-manifest-gate-runtime.ts';
const store = 'libs/core/governance/run-manifest-gate-store.ts';
const session = 'libs/core/pipeline/run-manifest-session.ts';
const charterRegistry = 'libs/core/governance/accountability-charter-registry.ts';
const reservationStore = 'libs/core/governance/external-operation-store.ts';
const operationRuntime = 'libs/core/governance/external-operation-runtime.ts';

describeStoreGrantBoundary('Run-manifest gate store capability trusted import boundary', {
  implementation: capability,
  issuers: new Map([
    ['withRunManifestGateBinding', [runtime]],
    ['withRunManifestGateStoreGrant', [store]],
  ]),
  consumers: new Map([
    [runtime, ['withRunManifestGateBinding']],
    [
      store,
      [
        'currentRunManifestGateBinding',
        'RUN_MANIFEST_GATE_GRANT_ISSUANCE_RIGHT',
        'withRunManifestGateStoreGrant',
      ],
    ],
  ]),
});

describeStoreGrantBoundary('Run-manifest gate runtime trusted import boundary', {
  implementation: runtime,
  issuers: new Map([['withRunManifestGateStore', [session]]]),
  consumers: new Map([[session, ['withRunManifestGateStore']]]),
});

describeStoreGrantBoundary('Run-manifest gate store access trusted import boundary', {
  implementation: store,
  issuers: new Map([
    ['withRunManifestGateStoreAccess', [charterRegistry, reservationStore, operationRuntime]],
  ]),
  consumers: new Map([
    [charterRegistry, ['runManifestGateCoversCharterScope', 'withRunManifestGateStoreAccess']],
    [reservationStore, ['currentRunManifestGateTenant', 'withRunManifestGateStoreAccess']],
    [operationRuntime, ['currentRunManifestGateTenant', 'withRunManifestGateStoreAccess']],
  ]),
});
