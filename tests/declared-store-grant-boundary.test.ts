import { describeStoreGrantBoundary } from './helpers/store-grant-boundary.js';

// S4 slice 3: a declared store grant is live only through the token its facade's
// authority.ts `withStoreGrant` opened. Opening or revoking a token is the sensitive act, so
// only authority.ts names the token issuer; the guard and its narrowing rules only read.
const reader = ['rolePermissionRecord'];

describeStoreGrantBoundary('Declared store grant trusted import boundary', {
  implementation: 'libs/core/foundation/declared-store-grant.ts',
  issuers: new Map([
    ['openDeclaredStoreGrantToken', ['libs/core/authority.ts']],
    ['closeDeclaredStoreGrantToken', ['libs/core/authority.ts']],
  ]),
  consumers: new Map<string, readonly string[]>([
    [
      'libs/core/authority.ts',
      [
        'closeDeclaredStoreGrantToken',
        'declaredStoreGrantDefinition',
        'isDeclaredStoreGrantName',
        'openDeclaredStoreGrantToken',
      ],
    ],
    [
      'libs/core/tier-guard.ts',
      ['isDeclaredStoreGrantName', 'liveDeclaredStoreGrant', 'rolePermissionRecord'],
    ],
    ['libs/core/foundation/role-narrowing-denial.ts', reader],
    // Test-only entry that opens a name as its facade would (role or grant).
    ['libs/core/testing/role-or-store-grant.ts', ['isDeclaredStoreGrantName']],
    ['libs/core/tier-guard-tenant-store-partitions.ts', reader],
  ]),
});
