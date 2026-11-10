import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import * as paths from './path-resolver.js';
import { resetRoleAssumptionPolicyCache, withExecutionContext } from './authority.js';
import { validateReadPermission, validateWritePermission } from './tier-guard.js';
import {
  createSynchronousResourceGrantIssuer,
  currentResourceAccessScope,
  runInResourceAccessScope,
  type ResourceAccessScope,
} from './foundation/resource-access-scope.js';
import {
  withDotResultStoreCapability,
  isDotResultStoreCapability,
  type DotResultStoreBinding,
  type DotResultStoreOperation,
} from './foundation/dot-result-store-capability.js';
import {
  safeMkdir,
  safeWriteFile,
  safeReadFile,
  safeAppendFileSync,
  safeRmSync,
  safeReaddir,
  safeLstat,
  safeMoveSync,
  safeOpenAppendFile,
  withSafeAppendFile,
  safeSymlinkSync,
  safeLinkExclusiveSync,
} from './secure-io.js';
vi.mock('./governance/audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('./governance/policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true }) },
}));
const sourceRoot = pathResolver.rootDir();
const tenant = 'dot-result-test';
const file = `active/shared/runtime/dot/confidential/${tenant}/organizations/org-a/projects/project-a/work-results.jsonl`;
let root: string;
const binding = (): DotResultStoreBinding => ({
  rootDir: root,
  scope: {
    tier: 'confidential',
    tenant_slug: tenant,
    organization_id: 'org-a',
    project_id: 'project-a',
  },
  dotId: 'repair-dot',
  file,
});
const at = (value = file) => path.join(root, value);
// G2: the grant alone authorizes DOT result I/O; there is no store role to assume.
const writer = <T>(fn: () => T): T => fn();
const append = <T>(fn: () => T) => withDotResultStoreCapability(binding(), 'append_result', fn);
const assumeRemovedRole = () =>
  withExecutionContext('dot_result_writer', () => undefined, undefined, tenant, 'org-a');
beforeEach(() => {
  root = path.join(sourceRoot, 'active/shared/tmp/dot-result-cap-' + crypto.randomUUID());
  safeMkdir(path.join(root, 'knowledge/personal/tenants'), { recursive: true });
  safeWriteFile(
    path.join(root, `knowledge/personal/tenants/${tenant}.json`),
    JSON.stringify({
      tenant_slug: tenant,
      status: 'active',
      assigned_role: 'owner',
      display_name: 'Synthetic fixture',
    })
  );
  vi.spyOn(pathResolver, 'rootDir').mockReturnValue(root);
  vi.spyOn(paths, 'rootDir').mockReturnValue(root);
  vi.spyOn(pathResolver, 'rootResolve').mockImplementation((value) => path.resolve(root, value));
  vi.stubEnv('KYBERION_TENANT', tenant);
  vi.stubEnv('SYSTEM_ROLE', '');
  vi.stubEnv('MISSION_ROLE', 'infrastructure_sentinel');
  vi.stubEnv('KYBERION_BASE_ROLE', 'worker');
  vi.stubEnv('KYBERION_SUDO', 'false');
  resetRoleAssumptionPolicyCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetRoleAssumptionPolicyCache();
  safeRmSync(root, { recursive: true, force: true });
});

describe('internal DOT result capability under actual registered policy', () => {
  it.each(['append_result', 'append_report_marker', 'read_state'] as const)(
    'preserves the operation ceiling matrix for %s',
    (domainOperation: DotResultStoreOperation) => {
      const writing = domainOperation !== 'read_state';
      withDotResultStoreCapability(binding(), domainOperation, () => {
        const scope = currentResourceAccessScope();
        const cases = [
          { target: file, read: !writing, append: writing, mkdir: false, metadata: true },
          {
            target: path.posix.dirname(file),
            read: false,
            append: false,
            mkdir: writing,
            metadata: true,
          },
          { target: '', read: false, append: false, mkdir: false, metadata: true },
          { target: file + '.other', read: false, append: false, mkdir: false, metadata: false },
          { target: file + '/child', read: false, append: false, mkdir: false, metadata: false },
          {
            target: file.replace(tenant, 'other-tenant'),
            read: false,
            append: false,
            mkdir: false,
            metadata: false,
          },
        ];
        for (const row of cases) {
          for (const operation of ['read', 'append', 'mkdir', 'metadata'] as const)
            expect(
              isDotResultStoreCapability(scope, { rootDir: root, target: row.target, operation })
            ).toBe(row[operation]);
          expect(
            isDotResultStoreCapability(scope, {
              rootDir: root,
              target: row.target,
              operation: 'write',
            })
          ).toBe(false);
          expect(
            isDotResultStoreCapability(scope, {
              rootDir: root,
              target: row.target,
              operation: 'delete' as 'metadata',
            })
          ).toBe(false);
          expect(
            isDotResultStoreCapability(scope, {
              rootDir: sourceRoot,
              target: row.target,
              operation: 'metadata',
            })
          ).toBe(false);
        }
      });
    }
  );

  it('no longer has a store role: the former role name grants nothing, and system processes cannot assume it', () => {
    const asRemovedRole = <T>(fn: () => T) =>
      withExecutionContext('dot_result_writer', fn, undefined, tenant, 'org-a');
    expect(asRemovedRole(() => validateWritePermission(at(), 'append').allowed)).toBe(false);
    vi.stubEnv('SYSTEM_ROLE', 'operator_surface');
    expect(assumeRemovedRole).toThrow();
    withDotResultStoreCapability(binding(), 'append_result', () => {
      expect(assumeRemovedRole).toThrow();
      expect(validateWritePermission(at(), 'append').allowed).toBe(true);
    });
  });
  it('absorbs rejected promises and hostile thenables while invalidating their capability', async () => {
    expect(() =>
      withDotResultStoreCapability(binding(), 'append_result', () =>
        Promise.reject(new Error('rejected callback'))
      )
    ).toThrow(/ASYNC/);
    let later: boolean | undefined;
    const thenable = {
      then(_resolve: unknown, reject: (error: Error) => void) {
        later = isDotResultStoreCapability(currentResourceAccessScope(), {
          rootDir: root,
          target: file,
          operation: 'append',
        });
        reject(new Error('custom thenable rejection'));
      },
    };
    expect(() => withDotResultStoreCapability(binding(), 'append_result', () => thenable)).toThrow(
      /ASYNC/
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(later).toBe(false);
    expect(() =>
      withDotResultStoreCapability(binding(), 'append_result', () => currentResourceAccessScope())
    ).toThrow(/ESCAPE/);
  });
  it('allows exact append and separate state-read, while denying ordinary mutation and file descriptor escape', () => {
    append(() => {
      safeMkdir(path.dirname(at()), { recursive: true });
      safeAppendFileSync(at(), 'result\n');
      expect(() => safeWriteFile(at(), 'replace')).toThrow();
      expect(() => safeRmSync(at())).toThrow();
      expect(() => safeMoveSync(at(), at('moved.jsonl'))).toThrow();
      expect(() => safeOpenAppendFile(at())).toThrow();
      expect(() => withSafeAppendFile(at(), () => undefined)).toThrow();
      expect(() => safeReadFile(at())).toThrow();
      expect(() => safeReaddir(path.dirname(at()))).toThrow();
      expect(() => safeAppendFileSync(at().replace('work-results', 'other'), 'other')).toThrow();
      expect(() => safeAppendFileSync(at().replace('project-a', 'project-b'), 'other')).toThrow();
    });
    withDotResultStoreCapability(binding(), 'append_report_marker', () =>
      writer(() => safeAppendFileSync(at(), 'marker\n'))
    );
    withDotResultStoreCapability(binding(), 'read_state', () =>
      writer(() => {
        expect(safeReadFile(at(), { encoding: 'utf8' })).toBe('result\nmarker\n');
        expect(() => safeAppendFileSync(at(), 'read escalation')).toThrow();
        expect(() => safeMkdir(path.dirname(at()), { recursive: true })).toThrow();
      })
    );
  });
  it('authorizes with the active grant alone; forged, counterfeit and other-tenant use fail closed', () => {
    expect(validateWritePermission(at(), 'append').allowed).toBe(false);
    withDotResultStoreCapability(binding(), 'append_result', () => {
      expect(validateWritePermission(at(), 'append').allowed).toBe(true);
    });
    expect(validateWritePermission(at(), 'append').allowed).toBe(false);
    // A caller bound to another tenant gains nothing from the grant.
    withExecutionContext(
      'infrastructure_sentinel',
      () =>
        withDotResultStoreCapability(binding(), 'append_result', () => {
          expect(validateWritePermission(at(), 'append').allowed).toBe(false);
        }),
      undefined,
      'other-tenant'
    );
    const forged: ResourceAccessScope = {
      tenantSlug: tenant,
      organizationId: 'org-a',
      projectId: 'project-a',
      readExact: [],
      writeExact: [],
      appendExact: [file],
      mkdirExact: [],
      opaqueStoreToken: {},
    };
    runInResourceAccessScope(forged, () =>
      expect(validateWritePermission(at(), 'append').allowed).toBe(false)
    );
    const counterfeitIssuer = createSynchronousResourceGrantIssuer('DOT_RESULT_CAPABILITY');
    const { opaqueStoreToken: _token, ...sameCeiling } = forged;
    counterfeitIssuer.run(
      Object.freeze({ binding: binding(), operation: 'append_result' }),
      sameCeiling,
      () => {
        expect(validateWritePermission(at(), 'append').allowed).toBe(false);
      }
    );
  });
  it('invalidates escaped scope, spread copies, exceptions and queued asynchronous callbacks', async () => {
    let escaped: ResourceAccessScope | undefined;
    let queued: Promise<boolean> | undefined;
    withDotResultStoreCapability(binding(), 'append_result', () => {
      escaped = currentResourceAccessScope();
      expect(
        isDotResultStoreCapability(escaped, { rootDir: root, target: file, operation: 'append' })
      ).toBe(true);
      expect(
        isDotResultStoreCapability(
          { ...escaped! },
          { rootDir: root, target: file, operation: 'append' }
        )
      ).toBe(false);
      expect(
        isDotResultStoreCapability(
          { ...escaped!, opaqueStoreToken: escaped!.opaqueStoreToken },
          { rootDir: root, target: file, operation: 'append' }
        )
      ).toBe(false);
      queued = Promise.resolve().then(() =>
        isDotResultStoreCapability(currentResourceAccessScope(), {
          rootDir: root,
          target: file,
          operation: 'append',
        })
      );
    });
    expect(await queued).toBe(false);
    expect(
      isDotResultStoreCapability(escaped, { rootDir: root, target: file, operation: 'append' })
    ).toBe(false);
    expect(() =>
      withDotResultStoreCapability(binding(), 'append_result', () => {
        escaped = currentResourceAccessScope();
        throw new Error('stop');
      })
    ).toThrow('stop');
    expect(
      isDotResultStoreCapability(escaped, { rootDir: root, target: file, operation: 'append' })
    ).toBe(false);
    expect(() =>
      withDotResultStoreCapability(binding(), 'append_result', () => Promise.resolve())
    ).toThrow(/ASYNC/);
    expect(
      runInResourceAccessScope(escaped!, () => validateWritePermission(at(), 'append').allowed)
    ).toBe(false);
  });
  it('cannot expand nested ceilings, root, scope, dot or operation arrays', () => {
    const outer: ResourceAccessScope = {
      tenantSlug: tenant,
      organizationId: 'org-a',
      projectId: 'project-a',
      readExact: [],
      writeExact: [],
      appendExact: [],
      mkdirExact: [],
    };
    runInResourceAccessScope(outer, () =>
      append(() => expect(validateWritePermission(at(), 'append').allowed).toBe(false))
    );
    withDotResultStoreCapability(binding(), 'append_result', () => {
      const scope = currentResourceAccessScope()!;
      for (const patch of [
        { appendExact: [file, 'active/shared/tmp/extra'] },
        { writeExact: [file] },
        { readExact: [file] },
        { projectId: 'other' },
        { allowProductKnowledgeRead: true },
      ])
        expect(
          isDotResultStoreCapability(
            { ...scope, ...patch, opaqueStoreToken: scope.opaqueStoreToken },
            { rootDir: root, target: file, operation: 'append' }
          )
        ).toBe(false);
      expect(
        isDotResultStoreCapability(scope, {
          rootDir: sourceRoot,
          target: file,
          operation: 'append',
        })
      ).toBe(false);
    });
    for (const patch of [
      { file: 'active/shared/tmp/other' },
      { dotId: '../dot' },
      { rootDir: root + '/../elsewhere' },
      { scope: { ...binding().scope, tier: 'public' } },
      { scope: { ...binding().scope, tenant_slug: 'other-tenant' } },
    ])
      expect(() =>
        withDotResultStoreCapability(
          { ...binding(), ...patch } as DotResultStoreBinding,
          'append_result',
          () => undefined
        )
      ).toThrow();
  });
  it('allows structural mkdir only, without structural body reads or ordinary writes', () => {
    append(() => {
      safeMkdir(path.dirname(at()), { recursive: true });
      expect(validateReadPermission(at('active/shared/runtime/dot/confidential')).allowed).toBe(
        false
      );
      expect(validateWritePermission(at('active/shared/runtime/dot/confidential')).allowed).toBe(
        false
      );
      expect(() => safeReaddir(at('active/shared/runtime/dot/confidential'))).toThrow();
      expect(() =>
        safeWriteFile(at('active/shared/runtime/dot/confidential'), 'structural')
      ).toThrow();
      expect(() =>
        safeMkdir(at('active/shared/runtime/dot/confidential/other-tenant'), { recursive: true })
      ).toThrow();
    });
  });
  it('rejects a symlink alias instead of following a capability to another owner', () => {
    // Bootstrap through the real repository's existing public scratch permission.
    vi.mocked(pathResolver.rootDir).mockReturnValue(sourceRoot);
    vi.mocked(paths.rootDir).mockReturnValue(sourceRoot);
    safeMkdir(path.dirname(at()), { recursive: true });
    const foreign = file.replace('work-results.jsonl', 'foreign.jsonl');
    safeWriteFile(at(foreign), 'foreign');
    safeSymlinkSync(at(foreign), at());
    expect(safeLstat(at()).isSymbolicLink()).toBe(true);
    vi.mocked(pathResolver.rootDir).mockReturnValue(root);
    vi.mocked(paths.rootDir).mockReturnValue(root);
    append(() => expect(() => safeAppendFileSync(at(), 'alias')).toThrow());
    vi.mocked(pathResolver.rootDir).mockReturnValue(sourceRoot);
    vi.mocked(paths.rootDir).mockReturnValue(sourceRoot);
    expect(safeReadFile(at(foreign), { encoding: 'utf8' })).toBe('foreign');
  });
  it('refuses branded append and state reads of a foreign hardlink, preserving both aliases bytes', () => {
    vi.mocked(pathResolver.rootDir).mockReturnValue(sourceRoot);
    vi.mocked(paths.rootDir).mockReturnValue(sourceRoot);
    safeMkdir(path.dirname(at()), { recursive: true });
    const foreign = file.replace('work-results.jsonl', 'foreign-hardlink.jsonl');
    const bytes = 'immutable foreign result\n';
    safeWriteFile(at(foreign), bytes);
    safeLinkExclusiveSync(at(foreign), at());
    vi.mocked(pathResolver.rootDir).mockReturnValue(root);
    vi.mocked(paths.rootDir).mockReturnValue(root);
    append(() => expect(() => safeAppendFileSync(at(), 'must not append\n')).toThrow(/hard link/));
    withDotResultStoreCapability(binding(), 'read_state', () =>
      writer(() => {
        expect(() => safeReadFile(at(), { encoding: 'utf8' })).toThrow(/hard link/);
      })
    );
    // Ordinary secure reads also refuse multi-link files. Detach one name at a time
    // using existing public scratch permission, and verify bytes through each survivor.
    vi.mocked(pathResolver.rootDir).mockReturnValue(sourceRoot);
    vi.mocked(paths.rootDir).mockReturnValue(sourceRoot);
    safeRmSync(at(foreign));
    expect(safeReadFile(at(), { encoding: 'utf8' })).toBe(bytes);
    safeLinkExclusiveSync(at(), at(foreign));
    safeRmSync(at());
    expect(safeReadFile(at(foreign), { encoding: 'utf8' })).toBe(bytes);
  });
});
