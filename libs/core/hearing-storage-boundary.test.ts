import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const policyState = vi.hoisted(() => ({
  corrupt: false,
  missing: false,
  incomplete: '' as
    '' | 'empty' | 'missing_hearing_prefixes' | 'shadowed_hearing' | 'shared_hearing',
}));
vi.mock('./fs-primitives.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./fs-primitives.js')>();
  return {
    ...real,
    rawExistsSync: (file: string) =>
      policyState.missing && path.basename(file) === 'security-policy.json'
        ? false
        : real.rawExistsSync(file),
    rawReadTextFile: (file: string) => {
      const raw = real.rawReadTextFile(file);
      if (path.basename(file) !== 'security-policy.json') return raw;
      if (policyState.corrupt) return '{ invalid policy';
      if (policyState.incomplete === 'empty') return '{}';
      if (!policyState.incomplete) return raw;
      const policy = JSON.parse(raw);
      if (policyState.incomplete === 'missing_hearing_prefixes') {
        policy.tenant_scope.protected_prefixes = policy.tenant_scope.protected_prefixes.filter(
          (prefix: string) => !prefix.startsWith('active/shared/runtime/hearing/')
        );
      } else if (policyState.incomplete === 'shadowed_hearing') {
        policy.tenant_scope.protected_prefixes.unshift('active/shared/runtime/');
      } else {
        policy.tenant_scope.shared_prefixes.push('active/shared/runtime/hearing/');
      }
      return JSON.stringify(policy);
    },
  };
});

import { withExecutionContext as initialContext } from './authority.js';
import { rootDir } from './path-resolver.js';
import * as initialIO from './secure-io.js';

const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/hearing-boundary-' + process.pid);
let withExecutionContext = initialContext;
let { safeReadFile, safeRmSync, safeWriteFile, safeSymlinkSync, safeLinkExclusiveSync } = initialIO;
let guard: typeof import('./tier-guard.js');
let retention: typeof import('./storage-retention-catalog.js');
const savedRoot = process.env.KYBERION_ROOT;

// A fresh root preserves the real logical tier paths. The ordinary Vitest
// live-store remap deliberately places bytes outside the protected root.
beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"hearing-policy-fixture"}');
    const copy = (relative: string): void => {
      for (const name of initialIO.safeReaddir(path.join(SOURCE_ROOT, relative))) {
        const file = path.join(relative, name);
        const source = path.join(SOURCE_ROOT, file);
        const stat = initialIO.safeLstat(source);
        if (stat.isSymbolicLink()) throw new Error('Linked governance fixture');
        if (stat.isDirectory()) copy(file);
        else if (/\.(?:json|yaml)$/u.test(name))
          initialIO.safeWriteFile(path.join(ROOT, file), initialIO.safeReadFile(source));
      }
    };
    copy('knowledge/product/governance');
    copy('knowledge/product/schemas');
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  ({ safeReadFile, safeRmSync, safeWriteFile, safeSymlinkSync, safeLinkExclusiveSync } =
    await import('./secure-io.js'));
  ({ withExecutionContext } = await import('./authority.js'));
  guard = await import('./tier-guard.js');
  retention = await import('./storage-retention-catalog.js');
  expect((await import('./path-resolver.js')).rootDir()).toBe(ROOT);
}, 30_000);

const STORE = 'active/shared/runtime/hearing';
// PG-03 standing grants share the registered state-root boundary.
const GRANTS = 'active/shared/runtime/grants';
const grantFile = (tenant: string) =>
  path.join(ROOT, GRANTS, 'confidential', tenant, 'GRT-20261019-aaaaaaaaaaaa.json');
const TENANT = 'hearing-boundary-' + process.pid;
const OTHER = 'hearing-other-' + process.pid;
const session = (tenant = TENANT) =>
  path.join(ROOT, STORE, 'confidential', tenant, 'tenant/session.json');
const personal = path.join(
  ROOT,
  STORE,
  'personal/shared/unscoped/boundary-' + process.pid + '.json'
);
const keys = [
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_TENANT',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'KYBERION_AGENT_TIER',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const privileged = <T>(fn: () => T) => withExecutionContext('ecosystem_architect', fn);
const restricted = <T>(fn: () => T, tenant?: string) =>
  withExecutionContext('chronos_tenant_runner', fn, undefined, tenant);

function cleanup(): void {
  policyState.corrupt = false;
  policyState.missing = false;
  policyState.incomplete = '';
  privileged(() => {
    for (const tenant of [TENANT, OTHER])
      safeRmSync(path.join(ROOT, STORE, 'confidential', tenant), { recursive: true, force: true });
    safeRmSync(personal, { force: true });
    for (const tenant of [TENANT, OTHER])
      safeRmSync(path.join(ROOT, GRANTS, 'confidential', tenant), { recursive: true, force: true });
  });
}

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  cleanup();
  privileged(() => {
    safeWriteFile(session(), 'own tenant receipt');
    safeWriteFile(session(OTHER), 'other tenant receipt');
    safeWriteFile(personal, 'private receipt');
  });
});

afterAll(() => {
  cleanup();
  if (savedRoot === undefined) delete process.env.KYBERION_ROOT;
  else process.env.KYBERION_ROOT = savedRoot;
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(ROOT, { recursive: true, force: true })
  );
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('durable hearing storage uses real secureIO tier and tenant boundaries', () => {
  it('classifies hearing tiers without changing legacy metrics classification', () => {
    expect(guard.detectTier(session())).toBe('confidential');
    expect(guard.detectTier(personal)).toBe('personal');
    expect(
      guard.detectTier(path.join(ROOT, 'active/shared/runtime/usage-ledger/personal/shared/x'))
    ).toBe('public');
  });

  it('allows the existing architect authority to persist and read the protected state', () =>
    privileged(() => {
      expect(safeReadFile(session(), { encoding: 'utf8' })).toBe('own tenant receipt');
      expect(safeReadFile(personal, { encoding: 'utf8' })).toBe('private receipt');
    }));

  it('denies actual cross-tenant reads and writes while permitting own-tenant reads', () =>
    restricted(() => {
      expect(safeReadFile(session(), { encoding: 'utf8' })).toBe('own tenant receipt');
      expect(() => safeReadFile(session(OTHER), { encoding: 'utf8' })).toThrow(
        /tenant.scope_violation/
      );
      expect(() => safeWriteFile(session(OTHER), 'replace')).toThrow(/tenant.scope_violation/);
      expect(() => safeReadFile(personal, { encoding: 'utf8' })).toThrow(
        /tenant.scope_invalid_prefix/
      );
    }, TENANT));

  it('applies the same tenant boundary to the standing-grant store', () => {
    privileged(() => {
      safeWriteFile(grantFile(TENANT), 'own tenant grant');
      safeWriteFile(grantFile(OTHER), 'other tenant grant');
    });
    expect(guard.detectTier(grantFile(TENANT))).toBe('confidential');
    restricted(() => {
      expect(safeReadFile(grantFile(TENANT), { encoding: 'utf8' })).toBe('own tenant grant');
      expect(() => safeReadFile(grantFile(OTHER), { encoding: 'utf8' })).toThrow(
        /tenant.scope_violation/
      );
      expect(() => safeWriteFile(grantFile(OTHER), 'replace')).toThrow(/tenant.scope_violation/);
    }, TENANT);
  });

  it('does not let default runtime grants write a tier that the identity cannot write', () =>
    restricted(() => {
      expect(guard.validateWritePermission(session()).allowed).toBe(false);
      expect(() => safeWriteFile(session(), 'replace')).toThrow(
        /SECURITY|POLICY|Higher tier required|Sovereign Sanctuary/
      );
      expect(() => safeWriteFile(personal, 'replace')).toThrow(
        /SECURITY|POLICY|Higher tier required|Sovereign Sanctuary/
      );
    }, TENANT));

  it('denies unprivileged reads of both protected tiers', () =>
    restricted(() => {
      expect(() => safeReadFile(session(), { encoding: 'utf8' })).toThrow(
        /SECURITY|POLICY|Higher tier required|Sovereign Sanctuary/
      );
      expect(() => safeReadFile(personal, { encoding: 'utf8' })).toThrow(
        /SECURITY|POLICY|Higher tier required|Sovereign Sanctuary/
      );
    }));

  it('fails closed for missing policy only on protected hearing state', () =>
    privileged(() => {
      policyState.missing = true;
      for (const file of [session(), personal]) {
        expect(guard.validateReadPermission(file).allowed).toBe(false);
        expect(guard.validateWritePermission(file).allowed).toBe(false);
        expect(() => safeReadFile(file, { encoding: 'utf8' })).toThrow(
          /security-policy.json is missing/
        );
        expect(() => safeWriteFile(file, 'replace')).toThrow(/security-policy.json is missing/);
      }
      // Existing bootstrap semantics, including metrics, remain unchanged.
      for (const relative of [
        'knowledge/personal/bootstrap.md',
        'active/shared/runtime/usage-ledger/personal/shared/bootstrap.json',
        'active/shared/runtime/execution-metrics/confidential/acme/bootstrap.json',
      ]) {
        const file = path.join(ROOT, relative);
        expect(guard.validateReadPermission(file).allowed).toBe(true);
        expect(guard.validateWritePermission(file).allowed).toBe(true);
      }
      policyState.missing = false;
    }));

  it.each(['empty', 'missing_hearing_prefixes', 'shadowed_hearing', 'shared_hearing'] as const)(
    'fails closed before hearing access for a loaded but invalid %s policy declaration',
    (mode) =>
      privileged(() => {
        policyState.incomplete = mode;
        try {
          for (const file of [session(), personal]) {
            expect(guard.validateReadPermission(file).allowed).toBe(false);
            expect(guard.validateWritePermission(file).allowed).toBe(false);
            expect(() => safeReadFile(file, { encoding: 'utf8' })).toThrow(
              /hearing.policy_declaration_invalid/
            );
            expect(() => safeWriteFile(file, 'must not replace')).toThrow(
              /hearing.policy_declaration_invalid/
            );
          }
          if (mode === 'missing_hearing_prefixes') {
            const metrics = path.join(
              ROOT,
              'active/shared/runtime/usage-ledger/personal/shared/x.json'
            );
            expect(guard.validateReadPermission(metrics).allowed).toBe(true);
            expect(guard.validateWritePermission(metrics).allowed).toBe(true);
          }
        } finally {
          policyState.incomplete = '';
        }
        expect(safeReadFile(session(), { encoding: 'utf8' })).toBe('own tenant receipt');
        expect(safeReadFile(personal, { encoding: 'utf8' })).toBe('private receipt');
      })
  );

  it('fails closed for corrupt policy on actual protected reads and writes', () =>
    privileged(() => {
      policyState.corrupt = true;
      for (const file of [session(), personal]) {
        expect(guard.validateReadPermission(file).allowed).toBe(false);
        expect(guard.validateWritePermission(file).allowed).toBe(false);
        expect(() => safeReadFile(file, { encoding: 'utf8' })).toThrow(/cannot be parsed/);
        expect(() => safeWriteFile(file, 'replace')).toThrow(/cannot be parsed/);
      }
      policyState.corrupt = false;
    }));

  it('does not cross tenants through an ancestor symlink', () => {
    const link = path.join(path.dirname(session()), 'escape');
    privileged(() => safeSymlinkSync(path.dirname(session(OTHER)), link));
    restricted(() => {
      expect(() => safeReadFile(path.join(link, 'session.json'), { encoding: 'utf8' })).toThrow(
        /SECURITY|POLICY/
      );
      expect(() => safeWriteFile(path.join(link, 'session.json'), 'replace')).toThrow(
        /SECURITY|POLICY|Higher tier required/
      );
    }, TENANT);
  });

  it('denies personal writes from a downgraded agent even with an authorized role', () => {
    process.env.KYBERION_AGENT_TIER = 'public';
    privileged(() => {
      expect(() => safeWriteFile(personal, 'replace')).toThrow(/POLICY_BLOCKED/);
    });
  });

  it('does not expose a foreign tenant receipt through a hard-link alias', () => {
    const alias = path.join(path.dirname(session()), 'foreign-link.json');
    privileged(() => safeLinkExclusiveSync(session(OTHER), alias));
    restricted(() => {
      expect(() => safeReadFile(alias, { encoding: 'utf8' })).toThrow(/SECURITY|POLICY/);
      expect(() => safeWriteFile(alias, 'replace')).toThrow(/SECURITY|POLICY|Higher tier required/);
    }, TENANT);
  });

  it('keeps durable hearing receipts out of automatic tenant offboarding targets', async () => {
    const { collectScopeTargets } = await import('./scope-offboarding.js');
    privileged(() => {
      const targets = collectScopeTargets('tenant', TENANT);
      expect(
        targets.some((target) => target.path === STORE || target.path.startsWith(STORE + '/'))
      ).toBe(false);
      expect(safeReadFile(session(), { encoding: 'utf8' })).toBe('own tenant receipt');
    });
  });

  it('declares review-required state with no automatic expiry', () => {
    const catalog = retention.loadRetentionCatalog();
    for (const file of [
      STORE,
      STORE + '/confidential/acme/tenant/session.json',
      STORE + '/personal/shared/all/session.json',
    ]) {
      const entry = retention.retentionEntryForPath(catalog, file);
      expect(entry?.path).toBe(STORE);
      expect(entry?.artifact_class).toBe('state');
      expect(entry?.action).toBe('review_required');
      expect(entry?.ttl_days).toBeUndefined();
      expect(entry?.status_rules).toBeUndefined();
    }
  });
});
