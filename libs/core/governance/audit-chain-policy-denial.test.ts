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
      const { withExecutionContext } = await import(${JSON.stringify(moduleUrl('authority.js'))});
      const { auditChain, withAuditChainLock } = await import(${JSON.stringify(moduleUrl('governance/audit-chain.js'))});
      const { policyEngine } = await import(${JSON.stringify(moduleUrl('governance/policy-engine.js'))});
      const { runInResourceAccessScope } = await import(${JSON.stringify(moduleUrl('foundation/resource-access-scope.js'))});
      const root = process.env.KYBERION_ROOT;
      const tenant = 'audit-fixture-a';
      const role = 'dot_lifecycle_runtime_store';
      const asRuntime = (fn) => withExecutionContext(role, fn, undefined, tenant);
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
      const ceiling = errorOf(() => runInResourceAccessScope({
        tenantSlug:tenant, readExact:[], writeExact:[], mkdirExact:[]
      }, () => asRuntime(() => auditChain.record(entry('ceiling-denied')))));
      // Inspect only this synthetic fixture after leaving every tested scope.
      process.env.MISSION_ROLE = 'mission_controller';
      process.env.KYBERION_PERSONA = 'sovereign';
      process.env.KYBERION_TENANT = '';
      const readRows = (dir) => io.safeExistsSync(dir)
        ? io.safeReaddir(dir).filter(name => name.endsWith('.jsonl')).flatMap(name =>
          String(io.safeReadFile(dir+'/'+name)).trim().split('\\n').filter(Boolean).map(JSON.parse))
        : [];
      const master = readRows(root+'/active/shared/logs/audit');
      const mirror = readRows(root+'/active/shared/runtime/audit-mirror/confidential/'+tenant);
      process.stdout.write(JSON.stringify({
        denied, mismatch, ceiling,
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
        KYBERION_PERSONA: 'worker',
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
    expect(report.integrity).toMatchObject({ valid: 3, total: 3, corrupted: [] });
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
    ]);
    expect(report.master[1]).toMatchObject({
      agentId: 'original-worker',
      actor: { kind: 'service', id: 'service:original' },
      scope: { tier: 'confidential', tenant_slug: 'audit-fixture-a' },
    });
    expect(report.mirror.map((row: { id: string }) => row.id)).toEqual(
      report.master.map((row: { id: string }) => row.id)
    );
  });
});
