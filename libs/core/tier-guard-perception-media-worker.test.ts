import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { validateReadPermission, validateWritePermission } from './tier-guard.js';
import { safeLstat, safeMkdir, safeWriteFile } from './secure-io.js';
import { withExecutionContextAsync } from './authority.js';
import * as pathResolver from './path-resolver.js';
// Install the full identity resolver (MISSION_ROLE / tenant resolution) the
// production read path uses, instead of the bootstrap fallback.
import './authority.js';

// The tier guard emits best-effort audit events on denial; keep them off the
// real audit chain so the suite stays hermetic.
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
const SCRATCH = 'active/shared/tmp/confidential/acme-corp/perception/listen-test';
const SCRATCH_WAV = `${SCRATCH}/audio-16k-mono.wav`;

/** Interactive-CLI identity: no claim, no role, persona resolves to unknown. */
describe('tier-guard perception_media_worker authority role', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // The persisted-scope equivalent under vitest: tier + tenant only, no
    // persona/role — what an interactive `pnpm kyberion listen` carries.
    process.env.KYBERION_TIER = 'confidential';
    process.env.KYBERION_TENANT = TENANT;
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('an interactive (grant-less) identity can write the scratch but cannot lstat it', () => {
    // The write side is admitted by the active/shared/tmp/ default_allow —
    // the read side is what the new role fixes.
    expect(validateReadPermission(at(SCRATCH_WAV)).allowed).toBe(false);
    expect(() => safeLstat(at(SCRATCH))).toThrow(/ROLE_VIOLATION/);
  });

  it('inside the assumed role the same identity lstat/reads its own tenant scratch', async () => {
    safeMkdir(at(SCRATCH), { recursive: true });
    safeWriteFile(at(SCRATCH_WAV), Buffer.from('RIFF'));
    try {
      await withExecutionContextAsync(
        'perception_media_worker',
        async () => {
          expect(validateReadPermission(at(SCRATCH_WAV))).toEqual({ allowed: true });
          // The exact guarded read the STT bridge adapter performs.
          expect(safeLstat(at(SCRATCH_WAV)).isFile()).toBe(true);
          // The other protected floor the role mediates.
          expect(
            validateReadPermission(at('active/shared/staging/confidential/acme-corp/inbound/x.wav'))
              .allowed
          ).toBe(true);
          expect(
            validateReadPermission(
              at('active/shared/tmp/personal/acme-corp/perception/listen-y/x.wav')
            ).allowed
          ).toBe(true);
          // The semantic index subtree on the cache floor — the only cache
          // domain the role grants — read and written by see|watch --index
          // and see --search.
          for (const tier of ['confidential', 'personal'] as const) {
            const indexFile = `active/shared/cache/${tier}/acme-corp/perception/semantic/demo.json`;
            expect(validateReadPermission(at(indexFile)).allowed, indexFile).toBe(true);
            expect(validateWritePermission(at(indexFile)).allowed, indexFile).toBe(true);
            const indexDir = `active/shared/cache/${tier}/acme-corp/perception/`;
            expect(validateReadPermission(at(indexDir)).allowed, indexDir).toBe(true);
          }
        },
        'worker',
        TENANT
      );
    } finally {
      // Cleanup runs outside the assumed context — the tmp floor stays
      // removable under the default_allow write grant either way.
      const { safeRmSync } = await import('./secure-io.js');
      safeRmSync(at(SCRATCH), { recursive: true, force: true });
    }
  });

  it('the role never reads other tenants, other tiers, or non-media floors', async () => {
    await withExecutionContextAsync(
      'perception_media_worker',
      async () => {
        for (const relative of [
          // Another tenant's perception scratch / staging.
          'active/shared/tmp/confidential/other-co/perception/listen-x/x.wav',
          'active/shared/staging/confidential/other-co/inbound/x.wav',
          'active/shared/tmp/personal/other-co/perception/listen-x/x.wav',
          // The untenanted `shared` segment is not a partition the role owns.
          'active/shared/tmp/confidential/shared/perception/listen-x/x.wav',
          'active/shared/cache/confidential/shared/perception/semantic/x.json',
          // The index grant names the cache floor's perception/ subtree only:
          // another tenant's index stays denied, and on the personal tier —
          // where the bound persona holds no cache grant at all — every cache
          // domain outside perception/ stays denied too (the model store and
          // any other cache domain included).
          'active/shared/cache/confidential/other-co/perception/semantic/x.json',
          'active/shared/cache/personal/other-co/perception/semantic/x.json',
          'active/shared/cache/personal/acme-corp/perception-models/face.task',
          'active/shared/cache/personal/acme-corp/build/output.bin',
          'active/shared/cache/personal/acme-corp/semantic/x.json',
          // Tenant knowledge is outside the media-perception surface.
          'knowledge/confidential/acme-corp/notes.md',
          'knowledge/personal/tenants/acme-corp.json',
          // Runtime state and other floors are not perception media.
          'active/shared/runtime/tenant-ledger/confidential/acme-corp/x.json',
          'active/shared/artifacts/confidential/acme-corp/x.json',
          // Organization state and another tenant's projects are outside both
          // the role grants and the bound worker persona.
          'active/organizations/confidential/acme-corp/x.json',
          'active/projects/confidential/other-co/proj-1/x.md',
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
      withExecutionContextAsync('perception_media_worker', async () => 'unreachable', 'worker')
    ).rejects.toThrow(/ROLE_TENANT_SCOPE_REQUIRED/);
    await expect(
      withExecutionContextAsync(
        'perception_media_worker',
        async () => 'unreachable',
        'worker',
        'other-co'
      )
    ).rejects.toThrow(/ROLE_TENANT_SCOPE_MISMATCH/);
  });
});
