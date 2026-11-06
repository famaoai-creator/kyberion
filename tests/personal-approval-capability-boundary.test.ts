import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// G2: the personal approval owner IO window is module-private. Only the governed
// personal approval runtime opens it, and only the approval store location
// calls the runtime; tier-guard, authority.ts and the narrow store denial ask
// the pure predicate while the dedicated role still exists.
describeStoreGrantBoundary('Personal approval window trusted import boundary', {
  implementation: 'libs/core/foundation/personal-approval-io-capability.ts',
  issuers: new Map([
    ['withPersonalApprovalCapability', ['libs/core/governance/personal-approval-runtime.ts']],
  ]),
  consumers: new Map([
    [
      'libs/core/governance/personal-approval-runtime.ts',
      [
        'withPersonalApprovalCapability',
        'PERSONAL_APPROVAL_STORE_ROLE',
        'personalApprovalIoAllowed',
      ],
    ],
    ['libs/core/tier-guard.ts', ['PERSONAL_APPROVAL_STORE_ROLE', 'personalApprovalIoAllowed']],
    ['libs/core/authority.ts', ['PERSONAL_APPROVAL_STORE_ROLE', 'personalApprovalIoAllowed']],
    [
      'libs/core/foundation/narrow-store-role-denial.ts',
      ['PERSONAL_APPROVAL_STORE_ROLE', 'personalApprovalIoAllowed'],
    ],
  ]),
});

describeStoreGrantBoundary('Personal approval runtime trusted import boundary', {
  implementation: 'libs/core/governance/personal-approval-runtime.ts',
  issuers: new Map([
    ['withPersonalApprovalIo', ['libs/core/governance/approval-store-location.ts']],
  ]),
  consumers: new Map([
    [
      'libs/core/governance/approval-store-location.ts',
      [
        'currentPersonalApprovalOwnerHash',
        'personalApprovalOwnerHash',
        'PERSONAL_APPROVAL_STORE_ROLE',
        'withPersonalApprovalIo',
      ],
    ],
    [
      'libs/core/governance/approval-store.ts',
      ['currentPersonalApprovalOwnerHash', 'personalApprovalOwnerHash'],
    ],
  ]),
});
