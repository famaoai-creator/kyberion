import { afterEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext } from '../authority.js';
import { validateReadPermission, validateWritePermission } from '../tier-guard.js';
import { passkeyCredentialPath } from './passkey-credential-store.js';

vi.mock('../governance/audit-chain.js', () => ({
  auditChain: { record: vi.fn() },
}));

/**
 * The passkey file stays in the personal tier (it holds a member's public
 * keys and enrollment state): Concierge, which serves `/api/me/passkeys`,
 * must be able to read and write it, and an agent mission role must not.
 */
const ENV_KEYS = [
  'KYBERION_TENANT',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_SUDO',
  'MISSION_ID',
] as const;

function clearIdentity(): void {
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('passkey credential file authority', () => {
  it('lets sovereign_concierge read and write the member passkey file', () => {
    clearIdentity();
    const file = passkeyCredentialPath('owner');
    withExecutionContext('sovereign_concierge', () => {
      expect(validateWritePermission(file)).toMatchObject({ allowed: true });
      expect(validateReadPermission(file)).toMatchObject({ allowed: true });
    });
  });

  it('refuses a worker mission role writing it', () => {
    clearIdentity();
    const file = passkeyCredentialPath('owner');
    withExecutionContext('software_developer', () => {
      expect(validateWritePermission(file).allowed).toBe(false);
    });
  });
});
