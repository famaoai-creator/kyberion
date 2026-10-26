import { beforeEach, describe, expect, it, vi } from 'vitest';
const s = vi.hoisted(() => ({
  root: '/installation',
  scoped: false,
  fail: false,
  local: false,
  response: { ready: true, missing_files: [] as string[] },
  readDenied: false,
  rootLookups: 0,
  env: {} as Record<string, string>,
  calls: [] as Array<{ cwd: string; env: Record<string, string>; input: string }>,
  scope: { tier: 'confidential', tenant_slug: 'tenant-a', customer_stance: 'customer-a' },
}));
vi.mock('@agent/core/path-resolver', () => ({
  pathResolver: { rootDir: () => '/worktree', rootResolve: (p: string) => '/worktree/' + p },
}));
vi.mock('@agent/core/profile-root', () => ({
  resolveActiveProfileRoot: () => '/worktree/customer/customer-a',
}));
vi.mock('@agent/core/secure-io', () => ({
  safeExistsSync: () => {
    if (s.readDenied) throw new Error('read denied');
    return s.local;
  },
  safeExecResult: (_bin: string, _args: string[], options: (typeof s.calls)[number]) => {
    s.calls.push(options);
    return s.fail
      ? { status: 1, stdout: '', stderr: 'denied' }
      : {
          status: 0,
          stdout: '\nKYBERION_IDENTITY_READINESS:' + JSON.stringify(s.response) + '\n',
          stderr: '',
        };
  },
}));
vi.mock('@agent/core/scope-context', () => ({ resolveScopeContext: () => s.scope }));
vi.mock('@agent/core/scope-envelope', () => ({
  currentScopeEnvelope: () => (s.scoped ? {} : undefined),
}));
vi.mock('@agent/core/foundation', () => ({
  currentExecutionScope: () => undefined,
  parseSafeJsonInput: (raw: string) => JSON.parse(raw),
}));
vi.mock('@agent/core/foundation/resource-access-scope', () => ({
  currentResourceAccessScope: () => undefined,
}));
vi.mock('@agent/core/shell/sandbox-policy', () => ({ getPluginExecutionContext: () => undefined }));
vi.mock('@agent/core/foundation/env', () => ({
  isVitestProcess: () => false,
  getRegisteredEnvText: (name: string) => s.env[name],
}));
vi.mock('@agent/core/vcs/governance-host', () => ({
  resolveInstallationGovernanceRoot: () => {
    s.rootLookups++;
    if (s.root === 'unrelated') throw new Error('unrelated repository');
    return s.root;
  },
}));
vi.mock('@agent/core/governance/delegated-execution', () => ({
  hasDelegatedExecutionContext: () => false,
}));
vi.mock('@agent/core/governance/human-execution', () => ({
  hasHumanExecutionContext: () => false,
}));
vi.mock('@agent/core/governance/external-operation', () => ({
  hasExternalOperationAuthority: () => false,
}));
vi.mock('@agent/core/organization/tenant-governance', () => ({
  shellQuoteArg: (value: string) => `'${value}'`,
}));
import {
  inspectInstalledIdentity,
  inspectMissionPrerequisiteIdentity,
  canonicalAuthorityCommand,
} from './installed-identity.js';
describe('installation identity metadata', () => {
  beforeEach(() => {
    s.root = '/installation';
    s.scoped = false;
    s.fail = false;
    s.local = false;
    s.response = { ready: true, missing_files: [] };
    s.readDenied = false;
    s.rootLookups = 0;
    s.calls = [];
    s.env = {};
  });
  it('checks all mission identity prerequisites at the primary host without copying files', () => {
    expect(inspectMissionPrerequisiteIdentity()).toEqual({ ready: true, missing_files: [] });
    expect(JSON.parse(s.calls[0].input).requiredFiles).toEqual([
      'my-identity.json',
      'my-vision.md',
      'agent-identity.json',
    ]);
    expect(JSON.parse(s.calls[0].input).scope).toEqual(s.scope);
  });
  it('does not accept a partial primary identity or malformed metadata', () => {
    s.response = { ready: false, missing_files: ['my-vision.md'] };
    expect(inspectMissionPrerequisiteIdentity()).toMatchObject({
      ready: false,
      missing_files: ['my-vision.md'],
    });
    s.response = { ready: true, missing_files: ['my-vision.md'] };
    expect(inspectMissionPrerequisiteIdentity().ready).toBe(false);
    s.response = { ready: false, missing_files: ['secret.json'] };
    expect(inspectMissionPrerequisiteIdentity().ready).toBe(false);
  });
  it('refuses scoped mission probes and foreign installation roots', () => {
    s.scoped = true;
    expect(inspectMissionPrerequisiteIdentity().ready).toBe(false);
    expect(s.rootLookups).toBe(0);
    expect(s.calls).toEqual([]);
    s.scoped = false;
    s.root = 'unrelated';
    expect(inspectMissionPrerequisiteIdentity().ready).toBe(false);
    expect(s.calls).toEqual([]);
  });
  it('reads only metadata at the same-repository installation and preserves tenant/customer scope', () => {
    expect(inspectInstalledIdentity()).toEqual({
      ready: true,
      governance_root: '/installation',
      source: 'installation',
    });
    expect(s.calls[0].cwd).toBe('/installation');
    expect(s.calls[0].env).toMatchObject({
      KYBERION_TIER: 'confidential',
      KYBERION_TENANT: 'tenant-a',
      KYBERION_CUSTOMER: 'customer-a',
    });
    expect(JSON.parse(s.calls[0].input).scope).toEqual(s.scope);
  });
  it('reports restricted absence as unavailable without probing installation or advising onboarding', () => {
    s.scoped = true;
    const readiness = inspectInstalledIdentity();
    expect(readiness).toMatchObject({
      ready: false,
      source: 'unavailable',
      governance_root: '/worktree',
    });
    expect(readiness.next).toContain('standalone operator session');
    expect(readiness.next).not.toMatch(/onboard/i);
    expect(s.calls).toEqual([]);
    expect(s.rootLookups).toBe(0);
  });
  it('keeps a locally ready identity usable within its existing scope', () => {
    s.scoped = true;
    s.local = true;
    expect(inspectInstalledIdentity()).toEqual({
      ready: true,
      source: 'local',
      governance_root: '/worktree',
    });
    expect(s.calls).toEqual([]);
    expect(s.rootLookups).toBe(0);
  });
  it('treats denied scoped metadata as unavailable without escaping authority', () => {
    s.scoped = true;
    s.readDenied = true;
    expect(inspectInstalledIdentity().source).toBe('unavailable');
    expect(s.calls).toEqual([]);
    expect(s.rootLookups).toBe(0);
  });
  it.each(['KYBERION_SUDO', 'KYBERION_SUDO_SCOPE'])(
    'keeps %s callers local without forwarding elevation',
    (name) => {
      s.env[name] = 'present';
      expect(inspectInstalledIdentity().source).toBe('unavailable');
      expect(s.calls).toEqual([]);
      expect(s.rootLookups).toBe(0);
    }
  );
  it('reports unavailable instead of onboarding on denied access or unrelated repositories', () => {
    s.fail = true;
    expect(inspectInstalledIdentity().source).toBe('unavailable');
    s.calls = [];
    s.root = 'unrelated';
    expect(inspectInstalledIdentity().source).toBe('unavailable');
    expect(s.calls).toEqual([]);
  });
  it('pins both file option forms to the source paths and includes explicit scope', () => {
    const command = canonicalAuthorityCommand('/installation', [
      'preview',
      '--file',
      'input.json',
      '--out=reviewed.json',
    ]);
    expect(command).toContain('/worktree/input.json');
    expect(command).toContain('--out=/worktree/reviewed.json');
    expect(command).toContain("KYBERION_TENANT='tenant-a'");
    expect(command).toContain("KYBERION_CUSTOMER='customer-a'");
  });
});
