import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { validateReadPermission, validateWritePermission } from './tier-guard.js';
import { safeLstat, safeMkdir, safeWriteFile } from './secure-io.js';
import { withExecutionContextAsync } from './authority.js';
import * as pathResolver from './path-resolver.js';
import './authority.js';

vi.mock('./governance/audit-chain.js', () => ({
  auditChain: {
    record: vi.fn(),
  },
}));

const ROOT = pathResolver.rootDir();
const ENV_KEYS = [
  'KYBERION_TENANT',
  'KYBERION_TIER',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_SUDO',
  'MISSION_ID',
  'KYBERION_SCOPE_ENV_PATH',
  'KYBERION_TENANT_SCOPE_REQUIRED',
  'KYBERION_ENTITY_GOVERNANCE',
] as const;

const at = (relative: string): string => path.join(ROOT, relative);

const TENANT = 'acme-corp';
const SCRATCH = 'active/shared/tmp/confidential/acme-corp/actuator-playground';
const SESSION = `${SCRATCH}/sessions/demo.json`;

describe('tier-guard actuator_playground_worker authority role', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.KYBERION_TIER = 'confidential';
    process.env.KYBERION_TENANT = TENANT;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('an interactive identity can write the playground scratch but cannot lstat it', () => {
    expect(validateReadPermission(at(SESSION)).allowed).toBe(false);
    expect(() => safeLstat(at(SCRATCH))).toThrow(/ROLE_VIOLATION/);
  });

  it('inside the assumed role the same identity reads its own tenant playground scratch', async () => {
    safeMkdir(at(`${SCRATCH}/sessions`), { recursive: true });
    safeWriteFile(at(SESSION), '{"session":"demo","steps":[]}');
    try {
      await withExecutionContextAsync(
        'actuator_playground_worker',
        async () => {
          expect(validateReadPermission(at(SESSION))).toEqual({ allowed: true });
          expect(safeLstat(at(SESSION)).isFile()).toBe(true);
          expect(validateWritePermission(at(`${SCRATCH}/demo.adf.json`)).allowed).toBe(true);
          expect(
            validateReadPermission(
              at('active/shared/tmp/personal/acme-corp/actuator-playground/sessions/x.json')
            ).allowed
          ).toBe(true);
        },
        'worker',
        TENANT
      );
    } finally {
      const { safeRmSync } = await import('./secure-io.js');
      safeRmSync(at(SCRATCH), { recursive: true, force: true });
    }
  });

  it('the role never reads other tenants, knowledge, or runtime ledgers', async () => {
    await withExecutionContextAsync(
      'actuator_playground_worker',
      async () => {
        for (const relative of [
          'active/shared/tmp/confidential/other-co/actuator-playground/sessions/x.json',
          'active/shared/tmp/confidential/shared/actuator-playground/x.json',
          'knowledge/confidential/acme-corp/notes.md',
          'active/shared/runtime/tenant-ledger/confidential/acme-corp/x.json',
        ]) {
          expect(validateReadPermission(at(relative)).allowed, relative).toBe(false);
        }
      },
      'worker',
      TENANT
    );
  });

  it('the tenant-bound role refuses an unbound or foreign-tenant assumption', async () => {
    await expect(
      withExecutionContextAsync('actuator_playground_worker', async () => 'unreachable', 'worker')
    ).rejects.toThrow(/ROLE_TENANT_SCOPE_REQUIRED/);
    await expect(
      withExecutionContextAsync(
        'actuator_playground_worker',
        async () => 'unreachable',
        'worker',
        'other-co'
      )
    ).rejects.toThrow(/ROLE_TENANT_SCOPE_MISMATCH/);
  });
});
