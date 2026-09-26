import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertChronosPipelinePath,
  assertRegisteredTenantPipeline,
  buildTenantRunEnv,
  collectTenantPipelineFiles,
  requireTenantPipelineTrust,
  resolveTenantRuntimeEnv,
} from './chronos_daemon.js';

describe('chronos pipeline scope', () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      const root = roots.pop();
      if (root) fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects paths outside pipelines/', () => {
    const root = fs.mkdtempSync(path.join(pathResolver.sharedTmp(''), 'chronos-scope-'));
    roots.push(root);

    expect(() => assertChronosPipelinePath(path.join(root, '../outside.json'), root)).toThrow(
      '[CHRONOS_SCOPE]'
    );
  });

  it('rejects a symlinked scheduled pipeline', () => {
    const root = fs.mkdtempSync(path.join(pathResolver.sharedTmp(''), 'chronos-scope-'));
    roots.push(root);
    const pipelines = path.join(root, 'pipelines');
    safeMkdir(pipelines, { recursive: true });
    const target = path.join(root, 'outside.json');
    safeWriteFile(target, '{}');
    fs.symlinkSync(target, path.join(pipelines, 'linked.json'));

    expect(() => assertChronosPipelinePath(path.join(pipelines, 'linked.json'), root)).toThrow(
      'symbolic link'
    );
  });

  it('accepts a regular repository pipeline JSON', () => {
    const root = fs.mkdtempSync(path.join(pathResolver.sharedTmp(''), 'chronos-scope-'));
    roots.push(root);
    const pipeline = path.join(root, 'pipelines', 'safe.json');
    safeMkdir(path.dirname(pipeline), { recursive: true });
    safeWriteFile(pipeline, '{}');

    expect(() => assertChronosPipelinePath(pipeline, root)).not.toThrow();
  });

  describe('tenant-scoped pipelines', () => {
    function tenantRoot(): string {
      const root = fs.mkdtempSync(path.join(pathResolver.sharedTmp(''), 'chronos-tenant-'));
      roots.push(root);
      const tenants = path.join(root, 'knowledge', 'personal', 'tenants');
      safeMkdir(tenants, { recursive: true });
      for (const [slug, status] of [
        ['acme-corp', 'active'],
        ['paused-co', 'suspended'],
      ]) {
        safeWriteFile(
          path.join(tenants, `${slug}.json`),
          JSON.stringify({ tenant_slug: slug, display_name: slug, status, assigned_role: 'owner' })
        );
        const dir = path.join(root, 'knowledge', 'confidential', slug, 'pipelines');
        safeMkdir(path.join(dir, 'nested'), { recursive: true });
        safeWriteFile(path.join(dir, 'weekly.json'), '{}');
        safeWriteFile(path.join(dir, 'nested', 'deep.json'), '{}');
      }
      // A directory for a tenant that has no registry profile.
      const ghost = path.join(root, 'knowledge', 'confidential', 'ghost-co', 'pipelines');
      safeMkdir(ghost, { recursive: true });
      safeWriteFile(path.join(ghost, 'x.json'), '{}');
      return root;
    }

    it('classifies a tenant pipeline path and derives the tenant from the path', () => {
      const root = tenantRoot();
      const file = path.join(root, 'knowledge/confidential/acme-corp/pipelines/weekly.json');
      expect(assertChronosPipelinePath(file, root)).toEqual({
        kind: 'tenant',
        relative: 'knowledge/confidential/acme-corp/pipelines/weekly.json',
        tenant_slug: 'acme-corp',
      });
    });

    it('rejects nested, reserved-slug and symlinked tenant paths', () => {
      const root = tenantRoot();
      expect(() =>
        assertChronosPipelinePath(
          path.join(root, 'knowledge/confidential/acme-corp/pipelines/nested/deep.json'),
          root
        )
      ).toThrow('[CHRONOS_SCOPE]');
      expect(() =>
        assertChronosPipelinePath(
          path.join(root, 'knowledge/confidential/public/pipelines/a.json'),
          root
        )
      ).toThrow('[CHRONOS_SCOPE]');
      const dir = path.join(root, 'knowledge/confidential/acme-corp/pipelines');
      fs.symlinkSync(path.join(dir, 'weekly.json'), path.join(dir, 'linked.json'));
      expect(() => assertChronosPipelinePath(path.join(dir, 'linked.json'), root)).toThrow(
        'symbolic link'
      );
    });

    it('collects only direct, regular files of registered operational tenants', () => {
      const root = tenantRoot();
      const dir = path.join(root, 'knowledge/confidential/acme-corp/pipelines');
      fs.symlinkSync(path.join(dir, 'weekly.json'), path.join(dir, 'linked.json'));
      const found = collectTenantPipelineFiles(root).map((entry) => [
        entry.tenant_slug,
        path.relative(root, entry.file),
      ]);
      expect(found).toEqual([
        ['acme-corp', path.join('knowledge/confidential/acme-corp/pipelines/weekly.json')],
      ]);
    });

    it('re-verifies the tenant against the registry', () => {
      const root = tenantRoot();
      const scope = (slug: string) =>
        ({
          kind: 'tenant',
          relative: `knowledge/confidential/${slug}/pipelines/weekly.json`,
          tenant_slug: slug,
        }) as const;
      expect(() => assertRegisteredTenantPipeline(scope('acme-corp'), root)).not.toThrow();
      expect(() => assertRegisteredTenantPipeline(scope('ghost-co'), root)).toThrow(/no profile/);
      expect(() => assertRegisteredTenantPipeline(scope('paused-co'), root)).toThrow();
    });

    it('refuses an unattended tenant run without a human project-trust approval', () => {
      expect(() =>
        requireTenantPipelineTrust({
          kind: 'tenant',
          relative: `knowledge/confidential/acme-corp/pipelines/never-approved-${process.pid}-${Date.now()}.json`,
          tenant_slug: 'acme-corp',
        })
      ).toThrow('[TRUST_REQUIRED]');
    });

    describe('runtime needs (per-process scope)', () => {
      const scopeOf = (slug = 'acme-corp') =>
        ({
          kind: 'tenant',
          relative: `knowledge/confidential/${slug}/pipelines/weekly.json`,
          tenant_slug: slug,
        }) as const;

      function withAllowlist(root: string, allowlist: Record<string, unknown>): void {
        const file = path.join(
          root,
          'knowledge/confidential/acme-corp/governance/pipeline-runtime-allowlist.json'
        );
        safeMkdir(path.dirname(file), { recursive: true });
        safeWriteFile(file, JSON.stringify(allowlist));
      }

      const ALLOW = {
        authorized_scopes: ['confluence'],
        reasoning_backends: ['claude-cli'],
        egress_policy_refs: ['knowledge/confidential/acme-corp/governance/egress-policy.json'],
      };
      const RUNTIME = {
        authorized_scope: ['confluence'],
        reasoning_backend: 'claude-cli',
        egress_policy_ref: 'knowledge/confidential/acme-corp/governance/egress-policy.json',
      };

      it('injects exactly the declared, allowlisted needs — the egress overlay per tenant', () => {
        const root = tenantRoot();
        withAllowlist(root, ALLOW);
        expect(resolveTenantRuntimeEnv(scopeOf(), RUNTIME, root)).toEqual({
          AUTHORIZED_SCOPE: 'confluence',
          KYBERION_REASONING_BACKEND: 'claude-cli',
          KYBERION_TENANT_EGRESS_POLICY_PATH:
            'knowledge/confidential/acme-corp/governance/egress-policy.json',
        });
        expect(resolveTenantRuntimeEnv(scopeOf(), undefined, root)).toEqual({});
      });

      it('refuses any need when the tenant has no allowlist (deny-by-default)', () => {
        const root = tenantRoot();
        expect(() => resolveTenantRuntimeEnv(scopeOf(), RUNTIME, root)).toThrow(
          /\[CHRONOS_RUNTIME\].*no governance\/pipeline-runtime-allowlist\.json/
        );
      });

      it('refuses a scope beyond the tenant allowlist or the global ceiling', () => {
        const root = tenantRoot();
        withAllowlist(root, { ...ALLOW, authorized_scopes: ['confluence'] });
        expect(() =>
          resolveTenantRuntimeEnv(scopeOf(), { authorized_scope: ['jira'] }, root)
        ).toThrow(/authorized_scope 'jira' is not in tenant 'acme-corp' allowlist/);
        withAllowlist(root, { ...ALLOW, authorized_scopes: ['no-such-service'] });
        expect(() =>
          resolveTenantRuntimeEnv(scopeOf(), { authorized_scope: ['no-such-service'] }, root)
        ).toThrow(/not a registered service \(global ceiling\)/);
        expect(() =>
          resolveTenantRuntimeEnv(scopeOf(), { authorized_scope: ['confluence', 'jira'] }, root)
        ).toThrow(/one service per process/);
        withAllowlist(root, ALLOW);
        expect(() =>
          resolveTenantRuntimeEnv(scopeOf(), { reasoning_backend: 'stub' }, root)
        ).toThrow(/not a governed reasoning mode/);
        expect(() =>
          resolveTenantRuntimeEnv(scopeOf(), { reasoning_backend: 'codex-cli' }, root)
        ).toThrow(/reasoning_backend 'codex-cli' is not in tenant/);
      });

      it("refuses an egress overlay outside the tenant's own root or not allowlisted", () => {
        const root = tenantRoot();
        withAllowlist(root, ALLOW);
        expect(() =>
          resolveTenantRuntimeEnv(
            scopeOf(),
            { egress_policy_ref: 'knowledge/confidential/other-co/governance/egress-policy.json' },
            root
          )
        ).toThrow(
          /egress_policy_ref must be a JSON file inside knowledge\/confidential\/acme-corp\//
        );
        expect(() =>
          resolveTenantRuntimeEnv(
            scopeOf(),
            { egress_policy_ref: 'knowledge/confidential/acme-corp/other.json' },
            root
          )
        ).toThrow(/egress_policy_ref .* is not in tenant 'acme-corp' allowlist/);
      });

      it('never leaks the daemon env or another run into a tenant child env', () => {
        const saved = { ...process.env };
        process.env.AUTHORIZED_SCOPE = 'slack';
        process.env.KYBERION_REASONING_BACKEND = 'codex-cli';
        process.env.KYBERION_TENANT_EGRESS_POLICY_PATH = 'knowledge/confidential/other-co/x.json';
        process.env.KYBERION_SUDO = 'true';
        try {
          const withNeeds = buildTenantRunEnv('acme-corp', {
            AUTHORIZED_SCOPE: 'confluence',
            KYBERION_TENANT_EGRESS_POLICY_PATH:
              'knowledge/confidential/acme-corp/governance/egress-policy.json',
          });
          const without = buildTenantRunEnv('other-co');
          expect(withNeeds).toEqual({
            AUTHORIZED_SCOPE: 'confluence',
            KYBERION_TENANT_EGRESS_POLICY_PATH:
              'knowledge/confidential/acme-corp/governance/egress-policy.json',
            KYBERION_TENANT: 'acme-corp',
            KYBERION_TENANT_SCOPE_REQUIRED: '1',
            MISSION_ROLE: 'chronos_tenant_runner',
            KYBERION_PERSONA: 'worker',
            KYBERION_SUDO: '',
          });
          // A pipeline that declares nothing gets explicit blanks, not the daemon's values.
          expect(without.AUTHORIZED_SCOPE).toBe('');
          expect(without.KYBERION_TENANT_EGRESS_POLICY_PATH).toBe('');
          expect(without.KYBERION_REASONING_BACKEND).toBeUndefined();
          expect(without.KYBERION_TENANT).toBe('other-co');
          // Building child envs never mutates the daemon's own env.
          expect(process.env.AUTHORIZED_SCOPE).toBe('slack');
          expect(process.env.KYBERION_TENANT).toBe(saved.KYBERION_TENANT);
        } finally {
          for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
          Object.assign(process.env, saved);
        }
      });
    });
  });
});
