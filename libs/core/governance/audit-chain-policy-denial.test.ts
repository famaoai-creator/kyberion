import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pathResolver } from '../path-resolver.js';
import {
  safeExecResult,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';

const sourceRoot = pathResolver.rootDir();
const fixture = pathResolver.sharedTmp('audit-owned-persistence-' + randomUUID());
const moduleUrl = (file: string) =>
  pathToFileURL(path.join(sourceRoot, 'libs/core/dist', file)).href;

afterEach(() => safeRmSync(fixture, { recursive: true, force: true }));

describe('audit-owned persistence under real production authority', () => {
  it('persists narrow-role denials with original attribution and retains caller resource ceilings', () => {
    const governance = path.join(fixture, 'knowledge/product/governance');
    safeMkdir(governance, { recursive: true });
    safeWriteFile(path.join(fixture, 'package.json'), '{}');
    safeWriteFile(
      path.join(governance, 'security-policy.json'),
      safeReadFile(path.join(sourceRoot, 'knowledge/product/governance/security-policy.json'))
    );
    safeWriteFile(
      path.join(governance, 'agent-policies.yaml'),
      'policies:\n  - name: fixture-denial\n    rules:\n      - field: operation\n        operator: eq\n        value: file_write\n        action: deny\n        priority: 100\n        message: synthetic-audit-denial\n'
    );
    const script = `
      const io = await import(${JSON.stringify(moduleUrl('secure-io.js'))});
      const { withStoreGrant, resolveRole } = await import(${JSON.stringify(moduleUrl('authority.js'))});
      const { auditChain, withAuditChainLock } = await import(${JSON.stringify(moduleUrl('governance/audit-chain.js'))});
      const { policyEngine } = await import(${JSON.stringify(moduleUrl('governance/policy-engine.js'))});
      const { runInResourceAccessScope } = await import(${JSON.stringify(moduleUrl('foundation/resource-access-scope.js'))});
      const root = process.env.KYBERION_ROOT;
      const tenant = 'audit-fixture-a';
      const role = 'dot_lifecycle_runtime_store';
      // S4: dot_lifecycle_runtime_store is a declared store grant.
      const asRuntime = (fn) => withStoreGrant(role, fn, { tenantSlug: tenant });
      const entry = (action) => ({agentId:'original-worker', action, operation:'fixture', result:'completed'});
      const errorOf = (fn) => { try { fn(); return null; } catch (error) { return String(error.message); } };
      // A cold key preflight must use the same private persistence boundary.
      asRuntime(() => auditChain.assertRecordable(entry('preflight')));
      policyEngine.loadFromFile(root + '/knowledge/product/governance/agent-policies.yaml');
      const target = root + '/active/shared/runtime/heartbeats/denied.json';
      const denied = errorOf(() => asRuntime(() => io.safeWriteFile(target, '{}')));
      const mismatch = errorOf(() => asRuntime(() => auditChain.record({
        ...entry('mismatch'), tenantSlug:'audit-fixture-b'
      })));
      process.env.KYBERION_TIER = 'confidential';
      const deferred = {...entry('deferred-original'), actor:{kind:'service',id:'service:original'}};
      withAuditChainLock(() => {
        asRuntime(() => auditChain.recordDeferrable(deferred));
        deferred.agentId = 'forged-worker';
        deferred.actor.id = 'service:forged';
        process.env.KYBERION_TIER = 'personal';
      });
      process.env.KYBERION_TIER = 'confidential';
      withAuditChainLock(() => asRuntime(() => auditChain.recordHeld(entry('held-original'))));
      const observations = [];
      const observe = (mode, callback) => observations.push({mode, callback, role:resolveRole()});
      const invoke = (mode, value, submitted = () => {}) => {
        if (mode === 'held' || mode === 'deferred')
          return withAuditChainLock(() => {
            asRuntime(() => mode === 'held'
              ? auditChain.recordHeld(value) : auditChain.recordDeferrable(value));
            submitted();
          });
        return asRuntime(() => mode === 'assert'
          ? auditChain.assertRecordable(value) : auditChain.record(value));
      };
      for (const mode of ['direct','held','deferred','assert']) {
        process.env.KYBERION_TIER = 'confidential';
        const metadata = {
          get correlationId() { observe(mode,'correlation'); return 'captured-'+mode; },
          nested: { get value() { observe(mode,'getter'); return 'captured'; } },
          converted: { toJSON() {
            observe(mode,'toJSON');
            process.env.KYBERION_TIER = 'personal';
            return {value:'captured'};
          } },
          proxy: new Proxy({value:'captured'}, {
            get(target,key,receiver) { observe(mode,'proxy'); return Reflect.get(target,key,receiver); },
            ownKeys(target) { observe(mode,'proxy'); return Reflect.ownKeys(target); }
          }),
          mutable: {value:'captured'},
        };
        const value = {...entry('callbacks-'+mode),actor:{kind:'service',id:'service:original'},metadata};
        invoke(mode,value,() => {
          value.actor.id = 'service:forged';
          metadata.mutable.value = 'changed-after-prepare';
        });
      }
      process.env.KYBERION_TIER = 'confidential';
      const cyclicErrors = [];
      const foreignScopeErrors = [];
      for (const mode of ['direct','held','deferred','assert']) {
        const cyclic = {...entry('cyclic-'+mode),metadata:{}};
        cyclic.metadata.self = cyclic.metadata;
        cyclicErrors.push(errorOf(() => invoke(mode,cyclic)));
        const foreign = {
          ...entry('foreign-'+mode),scope:{tier:'confidential',tenant_slug:tenant},
          toJSON() {
            observe(mode,'foreign-toJSON');
            return {...entry('foreign-'+mode),scope:{tier:'confidential',tenant_slug:'audit-fixture-b'}};
          }
        };
        foreignScopeErrors.push(errorOf(() => invoke(mode,foreign)));
      }
      const ceiling = errorOf(() => runInResourceAccessScope({
        tenantSlug:tenant, readExact:[], writeExact:[], mkdirExact:[]
      }, () => asRuntime(() => auditChain.record(entry('ceiling-denied')))));
      const aliasActions = [];
      const aliasErrors = [];
      const nonStringErrors = [];
      const systemScopeErrors = [];
      for (const mode of ['direct','held','deferred','assert']) {
        for (const kind of ['empty-top','empty-scope','tojson-empty','null-top','null-scope']) {
          const action = 'tenant-alias-'+mode+'-'+kind;
          let value = entry(action);
          if (kind === 'empty-top') value.tenantSlug = '';
          if (kind === 'empty-scope') value.scope = {tier:'confidential',tenant_slug:''};
          if (kind === 'null-top') value.tenantSlug = null;
          if (kind === 'null-scope') value.scope = {tier:'confidential',tenant_slug:null};
          if (kind === 'tojson-empty') value.toJSON = () => {
            observe(mode,'empty-toJSON');
            return {...entry(action),tenantSlug:'',scope:{tier:'confidential',tenant_slug:''}};
          };
          aliasErrors.push(errorOf(() => invoke(mode,value)));
          if (mode !== 'assert') aliasActions.push(action);
        }
        for (const invalid of [0,false,{},[]])
          for (const canonical of ['tenantSlug','scope']) {
            const value = {...entry('non-string-'+mode),[canonical]:canonical === 'scope'
              ? {tier:'confidential',tenant_slug:invalid} : invalid};
            nonStringErrors.push(errorOf(() => invoke(mode,value)));
          }
        systemScopeErrors.push(errorOf(() => invoke(mode,{
          ...entry('system-scope-'+mode),scope:{tier:'public',scope_kind:'system',tenant_slug:''}
        })));
      }
      process.env.KYBERION_TIER = 'public';
      withStoreGrant(role, () => auditChain.record({
        ...entry('cleared-global'),tenantSlug:'',scope:{tier:'public',tenant_slug:''}
      }), { tenantSlug: '' });
      process.env.KYBERION_TENANT = '';
      withStoreGrant(role, () => auditChain.record({
        ...entry('unbound-global'),tenantSlug:null
      }));
      // Inspect only this synthetic fixture after leaving every tested scope.
      process.env.MISSION_ROLE = 'mission_controller';
      process.env.KYBERION_BASE_ROLE = 'sovereign';
      process.env.KYBERION_TENANT = '';
      const readRows = (dir) => io.safeExistsSync(dir)
        ? io.safeReaddir(dir).filter(name => name.endsWith('.jsonl')).flatMap(name =>
          String(io.safeReadFile(dir+'/'+name)).trim().split('\\n').filter(Boolean).map(JSON.parse))
        : [];
      const master = readRows(root+'/active/shared/logs/audit');
      const mirror = readRows(root+'/active/shared/runtime/audit-mirror/confidential/'+tenant);
      process.stdout.write(JSON.stringify({
        denied, mismatch, ceiling, observations, cyclicErrors, foreignScopeErrors,
        aliasActions, aliasErrors, nonStringErrors, systemScopeErrors,
        targetExists:io.safeExistsSync(target),
        keyExists:io.safeExistsSync(root+'/active/shared/runtime/audit/chain-key'),
        master, mirror,
        integrity:auditChain.verify(),
        mirrorIntegrity:auditChain.verifyTenantMirrors(),
        otherMirrorExists:io.safeExistsSync(root+'/active/shared/runtime/audit-mirror/confidential/audit-fixture-b')
      })+'\\n');
    `;
    const result = safeExecResult(process.execPath, ['--input-type=module', '-e', script], {
      cwd: fixture,
      timeoutMs: 30_000,
      env: {
        KYBERION_ROOT: fixture,
        KYBERION_BASE_ROLE: 'worker',
        MISSION_ROLE: 'worker',
        SYSTEM_ROLE: '',
        KYBERION_DELEGATED_ROLE: '',
        KYBERION_TENANT: 'audit-fixture-a',
        KYBERION_TIER: 'confidential',
        KYBERION_SUDO: 'false',
        KYBERION_AUDIT_CHAIN_KEY: '',
        MISSION_ID: '',
        VITEST: '',
        VITEST_POOL_ID: '',
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
    expect(report.denied).toContain('POLICY_BLOCKED');
    expect(report.targetExists).toBe(false);
    expect(report.keyExists).toBe(true);
    expect(report.mismatch).toContain('AUDIT_SCOPE_DENIED');
    expect(report.ceiling).toBeTruthy();
    expect(report.otherMirrorExists).toBe(false);
    expect(report.integrity).toMatchObject({ valid: 23, total: 23, corrupted: [] });
    expect(report.mirrorIntegrity).toEqual({ ok: true, findings: [] });
    const denied = report.master.filter(
      (row: { action: string }) => row.action === 'policy_violation'
    );
    expect(denied).toHaveLength(1);
    expect(denied[0].tenantSlug).toBe('audit-fixture-a');
    expect(report.master.map((row: { action: string }) => row.action)).toEqual([
      'policy_violation',
      'deferred-original',
      'held-original',
      'callbacks-direct',
      'callbacks-held',
      'callbacks-deferred',
      ...report.aliasActions,
      'cleared-global',
      'unbound-global',
    ]);
    expect(report.master[1]).toMatchObject({
      agentId: 'original-worker',
      actor: { kind: 'service', id: 'service:original' },
      scope: { tier: 'confidential', tenant_slug: 'audit-fixture-a' },
    });
    for (const mode of ['direct', 'held', 'deferred', 'assert']) {
      const observed = report.observations.filter((row: { mode: string }) => row.mode === mode);
      expect(observed.length).toBeGreaterThan(0);
      expect(
        observed.every((row: { role: string }) => row.role === 'dot_lifecycle_runtime_store')
      ).toBe(true);
      for (const callback of ['correlation', 'getter', 'toJSON', 'proxy', 'foreign-toJSON'])
        expect(observed.some((row: { callback: string }) => row.callback === callback)).toBe(true);
    }
    for (const row of report.master.filter((row: { action: string }) =>
      row.action.startsWith('callbacks-')
    ))
      expect(row).toMatchObject({
        actor: { kind: 'service', id: 'service:original' },
        correlationId: 'captured-' + row.action.replace('callbacks-', ''),
        scope: { tier: 'confidential', tenant_slug: 'audit-fixture-a' },
        metadata: {
          nested: { value: 'captured' },
          converted: { value: 'captured' },
          proxy: { value: 'captured' },
          mutable: { value: 'captured' },
        },
      });
    expect(report.cyclicErrors).toHaveLength(4);
    expect(
      report.cyclicErrors.every((error: string) => error.includes('AUDIT_INPUT_INVALID'))
    ).toBe(true);
    expect(report.foreignScopeErrors).toHaveLength(4);
    expect(
      report.foreignScopeErrors.every((error: string) => error.includes('AUDIT_SCOPE_DENIED'))
    ).toBe(true);
    expect(report.mirror.map((row: { id: string }) => row.id)).toEqual(
      report.master
        .filter((row: { tenantSlug?: string }) => row.tenantSlug === 'audit-fixture-a')
        .map((row: { id: string }) => row.id)
    );
    expect(report.aliasErrors).toEqual(Array(20).fill(null));
    expect(report.aliasActions).toHaveLength(15);
    for (const row of report.master.filter((row: { action: string }) =>
      row.action.startsWith('tenant-alias-')
    ))
      expect(row).toMatchObject({
        tenantSlug: 'audit-fixture-a',
        scope: { tier: 'confidential', tenant_slug: 'audit-fixture-a' },
      });
    expect(report.nonStringErrors).toHaveLength(32);
    expect(
      report.nonStringErrors.every((error: string) => error.includes('AUDIT_SCOPE_INVALID'))
    ).toBe(true);
    expect(report.systemScopeErrors).toHaveLength(4);
    expect(
      report.systemScopeErrors.every((error: string) => error.includes('AUDIT_SCOPE_INVALID'))
    ).toBe(true);
    for (const row of report.master.slice(-2)) {
      expect(row.tenantSlug).toBeUndefined();
      expect(row.scope).toEqual({ tier: 'public', scope_kind: 'system' });
    }
  });
});
