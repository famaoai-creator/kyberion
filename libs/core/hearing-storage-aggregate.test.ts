import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from './authority.js';
import { rootDir } from './path-resolver.js';
import * as initialIO from './secure-io.js';

const SOURCE = rootDir();
const ROOT = path.join(SOURCE, 'active/shared/tmp/hearing-aggregate-' + process.pid);
const STORE = 'active/shared/runtime/hearing';
const TENANT = 'hearing-own';
const OTHER = 'hearing-other';
const receipt = path.join(ROOT, STORE, 'personal/shared/all/receipt.json');
const confidential = (tenant: string) =>
  path.join(ROOT, STORE, 'confidential', tenant, 'tenant/receipt.json');
const moved = path.join(ROOT, 'active/shared/tmp/moved');
const keys = [
  'KYBERION_ROOT',
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
let io = initialIO;
let context = initialContext;
const privileged = <T,>(fn: () => T) => context('ecosystem_architect', fn);
const restricted = <T,>(role: string, fn: () => T) => context(role, fn, undefined, TENANT);

function provision() {
  initialContext('ecosystem_architect', () => {
    initialIO.safeRmSync(ROOT, { recursive: true, force: true });
    initialIO.safeWriteFile(
      path.join(ROOT, 'package.json'),
      '{"name":"hearing-aggregate-fixture"}'
    );
    const copy = (relative: string): void => {
      for (const name of initialIO.safeReaddir(path.join(SOURCE, relative))) {
        const file = path.join(relative, name);
        const stat = initialIO.safeLstat(path.join(SOURCE, file));
        if (stat.isSymbolicLink()) throw new Error('Linked governance fixture');
        if (stat.isDirectory()) copy(file);
        else if (/\.(?:json|yaml)$/u.test(name))
          initialIO.safeWriteFile(
            path.join(ROOT, file),
            initialIO.safeReadFile(path.join(SOURCE, file))
          );
      }
    };
    copy('knowledge/product/governance');
    copy('knowledge/product/schemas');
  });
}

beforeAll(async () => {
  provision();
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('./secure-io.js');
  ({ withExecutionContext: context } = await import('./authority.js'));
  expect((await import('./path-resolver.js')).shared('runtime/hearing')).toBe(
    path.join(ROOT, STORE)
  );
}, 30_000);

beforeEach(() => {
  for (const key of keys) if (key !== 'KYBERION_ROOT') delete process.env[key];
  process.env.MISSION_ID = 'MSN-HEARING-RECEIPT-RECOVERY-20261017';
  // Keep immutable governance between cases; restore it only if a regression
  // actually removed the fixture root. Every mutation below stays in active/.
  if (
    !initialIO.safeExistsSync(path.join(ROOT, 'knowledge/product/governance/security-policy.json'))
  ) {
    provision();
  } else {
    initialContext('ecosystem_architect', () =>
      initialIO.safeRmSync(path.join(ROOT, 'active'), { recursive: true, force: true })
    );
  }
  privileged(() => {
    io.safeWriteFile(receipt, 'private receipt');
    io.safeWriteFile(confidential(TENANT), 'own receipt');
    io.safeWriteFile(confidential(OTHER), 'other receipt');
    io.safeMkdir(path.dirname(moved), { recursive: true });
  });
});

afterAll(() => {
  if (saved.KYBERION_ROOT === undefined) delete process.env.KYBERION_ROOT;
  else process.env.KYBERION_ROOT = saved.KYBERION_ROOT;
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(ROOT, { recursive: true, force: true })
  );
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function assertUnchanged() {
  privileged(() => {
    expect(io.safeReadFile(receipt)).toBe('private receipt');
    expect(io.safeReadFile(confidential(OTHER))).toBe('other receipt');
  });
}
const denied = /SECURITY|POLICY|Higher tier required|Sovereign Sanctuary/;
const ancestors = [STORE, 'active/shared/runtime', 'active/shared', 'active', ''] as const;

describe('hearing aggregate move and removal boundaries', () => {
  for (const role of ['chronos_tenant_runner', 'ecosystem_architect']) {
    it.each(ancestors)(role + ' cannot move hearing ancestor %s', (relative) => {
      restricted(role, () =>
        expect(() => io.safeMoveSync(path.join(ROOT, relative), moved)).toThrow(denied)
      );
      assertUnchanged();
    });
    it.each(ancestors)(role + ' cannot recursively remove hearing ancestor %s', (relative) => {
      restricted(role, () =>
        expect(() =>
          io.safeRmSync(path.join(ROOT, relative), { recursive: true, force: true })
        ).toThrow(denied)
      );
      assertUnchanged();
    });
  }

  it('checks a canonical parent alias to the hearing root', () => {
    const alias = path.join(ROOT, 'active/shared/tmp/runtime-alias');
    privileged(() => io.safeSymlinkSync(path.join(ROOT, 'active/shared/runtime'), alias, 'dir'));
    restricted('chronos_tenant_runner', () => {
      expect(() => io.safeMoveSync(path.join(alias, 'hearing'), moved)).toThrow(denied);
      expect(() =>
        io.safeRmSync(path.join(alias, 'hearing'), { recursive: true, force: true })
      ).toThrow(denied);
    });
    assertUnchanged();
  });

  it('denies replacement of an empty hearing root from an unprotected source', () => {
    const source = path.join(ROOT, 'active/shared/tmp/replacement');
    privileged(() => {
      io.safeRmSync(path.join(ROOT, STORE), { recursive: true, force: true });
      io.safeMkdir(path.join(ROOT, STORE), { recursive: true });
      io.safeWriteFile(path.join(source, 'personal/shared/all/receipt.json'), 'replacement');
    });
    restricted('chronos_tenant_runner', () =>
      expect(() => io.safeMoveSync(source, path.join(ROOT, STORE))).toThrow(denied)
    );
    privileged(() =>
      expect(io.safeReadFile(path.join(source, 'personal/shared/all/receipt.json'))).toBe(
        'replacement'
      )
    );
  });

  it('denies canonical destination replacement of an empty hearing root', () => {
    const source = path.join(ROOT, 'active/shared/tmp/replacement');
    const alias = path.join(ROOT, 'active/shared/tmp/runtime-alias');
    privileged(() => {
      io.safeRmSync(path.join(ROOT, STORE), { recursive: true, force: true });
      io.safeMkdir(path.join(ROOT, STORE), { recursive: true });
      io.safeWriteFile(path.join(source, 'payload.json'), 'replacement');
      io.safeSymlinkSync(path.join(ROOT, 'active/shared/runtime'), alias, 'dir');
    });
    restricted('chronos_tenant_runner', () =>
      expect(() => io.safeMoveSync(source, path.join(alias, 'hearing'))).toThrow(denied)
    );
  });

  it('denies a tenant-bound architect aggregate operation even with only its own current descendants', () => {
    privileged(() => {
      io.safeRmSync(path.join(ROOT, STORE, 'personal'), { recursive: true, force: true });
      io.safeRmSync(path.join(ROOT, STORE, 'confidential', OTHER), {
        recursive: true,
        force: true,
      });
    });
    restricted('ecosystem_architect', () => {
      expect(() => io.safeMoveSync(path.join(ROOT, STORE), moved)).toThrow(denied);
      expect(() => io.safeRmSync(path.join(ROOT, STORE), { recursive: true, force: true })).toThrow(
        denied
      );
    });
    privileged(() => expect(io.safeReadFile(confidential(TENANT))).toBe('own receipt'));
  });

  it('keeps ordinary unbound architect cleanup and movement authorized', () =>
    privileged(() => {
      io.safeMoveSync(path.join(ROOT, STORE), moved);
      expect(io.safeReadFile(path.join(moved, 'personal/shared/all/receipt.json'))).toBe(
        'private receipt'
      );
      io.safeMoveSync(moved, path.join(ROOT, STORE));
      io.safeRmSync(path.join(ROOT, STORE), { recursive: true, force: true });
      expect(io.safeExistsSync(path.join(ROOT, STORE))).toBe(false);
    }));

  it('preserves leaf-symlink removal and unrelated runtime operations', () => {
    const alias = path.join(ROOT, 'active/shared/tmp/hearing-alias');
    const ordinary = path.join(ROOT, 'active/shared/runtime/unrelated');
    privileged(() => {
      io.safeSymlinkSync(path.join(ROOT, STORE), alias, 'dir');
      io.safeWriteFile(path.join(ordinary, 'public.json'), 'ordinary');
    });
    restricted('chronos_tenant_runner', () => {
      io.safeRmSync(alias, { recursive: true, force: true });
      io.safeMoveSync(ordinary, moved);
      io.safeRmSync(moved, { recursive: true, force: true });
    });
    assertUnchanged();
  });
});
