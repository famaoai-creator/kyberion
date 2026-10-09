import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { safeReadFile } from './secure-io.js';

// The tier guard emits best-effort audit events on denial; keep them off the
// real audit chain so the suite stays hermetic.
vi.mock('./governance/audit-chain.js', () => ({
  auditChain: { record: vi.fn() },
}));

/**
 * scripts/ts-loader.mjs executes its transpile-cache entries as code, so the
 * cache must sit where no governed persona can write through secure-io. Before
 * MSN-OPS-ROUND5 review H1 it lived in active/shared/cache/ (security-policy
 * default_allow), and a finance_controller worker could plant an entry that the
 * next loader run executed.
 */
const ROOT = pathResolver.rootDir();
const CACHE_ENTRY = path.join(ROOT, 'node_modules/.cache/kyberion-ts-loader/ab/ab00.transpiled');
const OLD_CACHE_ENTRY = path.join(ROOT, 'active/shared/cache/system/ts-loader/ab/ab00.transpiled');
const ENV_KEYS = [
  'KYBERION_TENANT',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_SUDO',
  'MISSION_ID',
  'KYBERION_TENANT_SCOPE_REQUIRED',
] as const;

type Policy = {
  persona_permissions: Record<string, unknown>;
  authority_role_permissions: Record<string, unknown>;
};

let validateWritePermission: (filePath: string) => { allowed: boolean; reason?: string };
let policy: Policy;

beforeAll(async () => {
  await import('./authority.js');
  ({ validateWritePermission } = await import('./tier-guard.js'));
  policy = JSON.parse(
    String(
      safeReadFile(pathResolver.rootResolve('knowledge/product/governance/security-policy.json'), {
        encoding: 'utf8',
      })
    )
  ) as Policy;
}, 60_000);

describe('ts-loader transpile cache location is not writable by governed personas', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('denies every persona', () => {
    const personas = Object.keys(policy.persona_permissions);
    expect(personas.length).toBeGreaterThan(3);
    const allowed = personas.filter((persona) => {
      process.env.KYBERION_PERSONA = persona;
      return validateWritePermission(CACHE_ENTRY).allowed;
    });
    expect(allowed).toEqual([]);
  });

  it('denies every authority role (SUDO authority aside, which is operator-equivalent)', () => {
    const roles = Object.keys(policy.authority_role_permissions);
    expect(roles.length).toBeGreaterThan(3);
    const allowed = roles.filter((role) => {
      process.env.KYBERION_PERSONA = 'worker';
      process.env.MISSION_ROLE = role;
      return validateWritePermission(CACHE_ENTRY).allowed;
    });
    expect(allowed).toEqual([]);
  });

  it('the old location under the cache floor was writable by a data-only role (why it moved)', () => {
    process.env.KYBERION_PERSONA = 'finance_controller';
    expect(validateWritePermission(OLD_CACHE_ENTRY).allowed).toBe(true);
    expect(validateWritePermission(CACHE_ENTRY).allowed).toBe(false);
  });
});
