import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import * as paths from './path-resolver.js';
import { resetRoleAssumptionPolicyCache, withExecutionContext } from './authority.js';
import { currentExecutionScope } from './foundation/execution-scope.js';
import { validateReadPermission, validateWritePermission } from './tier-guard.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';
import { dotStatePath } from './dot/dot-state-paths.js';
import { eventContinuationPath } from './dot/dot-event-continuation.js';
import type { DotCharter } from './dot/dot-charter.js';
import { asRoleOrGrant } from './testing/role-or-store-grant.js';

vi.mock('./governance/audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('./governance/policy-engine.js', () => ({
  policyEngine: { evaluate: () => ({ allowed: true }) },
}));

const sourceRoot = pathResolver.rootDir();
const tenantA = 'dot-purpose-a';
const tenantB = 'dot-purpose-b';
const roles = ['dot_charter_store', 'dot_lifecycle_runtime_store'] as const;
const eventsPath = (tenant: string) =>
  dotStatePath({ scope: { tier: 'confidential', tenant_slug: tenant } }, 'events.jsonl');
const continuationPath = (tenant: string) =>
  eventContinuationPath(
    {
      dot_id: 'purpose-guardian',
      scope: { tier: 'confidential', tenant_slug: tenant },
    } as DotCharter,
    '.'
  );
const personalEventsPath = dotStatePath(
  { scope: { tier: 'personal', owner_nhi: 'fixture-owner' } },
  'events.jsonl'
);
const publicEventsPath = dotStatePath({ scope: { tier: 'public' } }, 'events.jsonl');
function expectDecision(decision: { allowed: boolean; reason?: string }, allowed: boolean): void {
  expect(decision.allowed, decision.reason).toBe(allowed);
}
let root: string;
let escapeSource: string;
let escapeAlias: string;
const escapeContent = 'synthetic private source must remain unchanged\n';
const at = (target: string) => path.join(root, target);
const assume = <T>(role: string, fn: () => T, tenant = tenantA): T =>
  asRoleOrGrant(role, fn, undefined, tenant);

beforeEach(() => {
  root = path.join(sourceRoot, 'active/shared/tmp/dot-purpose-' + randomUUID());
  safeMkdir(at('knowledge/personal/tenants'), { recursive: true });
  for (const tenant of [tenantA, tenantB])
    safeWriteFile(
      at('knowledge/personal/tenants/' + tenant + '.json'),
      JSON.stringify({
        tenant_slug: tenant,
        status: 'active',
        assigned_role: 'owner',
        display_name: 'Synthetic DOT purpose fixture',
      })
    );
  escapeSource = at('knowledge/personal/synthetic-private.txt');
  escapeAlias = at(
    dotStatePath(
      { scope: { tier: 'confidential', tenant_slug: tenantA, organization_id: 'escape-org' } },
      'events.jsonl'
    )
  );
  safeWriteFile(escapeSource, escapeContent, { encoding: 'utf8' });
  safeMkdir(path.dirname(escapeAlias), { recursive: true });
  safeSymlinkSync(escapeSource, escapeAlias);
  vi.spyOn(pathResolver, 'rootDir').mockReturnValue(root);
  vi.spyOn(paths, 'rootDir').mockReturnValue(root);
  vi.spyOn(pathResolver, 'rootResolve').mockImplementation((target) => path.resolve(root, target));
  for (const key of [
    'SYSTEM_ROLE',
    'KYBERION_DELEGATED_ROLE',
    'KYBERION_ORGANIZATION_ID',
    'KYBERION_TENANT_SCOPE_REQUIRED',
  ])
    vi.stubEnv(key, '');
  vi.stubEnv('MISSION_ROLE', 'worker');
  vi.stubEnv('KYBERION_BASE_ROLE', 'worker');
  vi.stubEnv('KYBERION_SUDO', 'false');
  vi.stubEnv('KYBERION_TENANT', tenantA);
  resetRoleAssumptionPolicyCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetRoleAssumptionPolicyCache();
  safeRmSync(root, { recursive: true, force: true });
});

describe('DOT lifecycle store purpose boundaries under registered policy', () => {
  it.each([
    ['dot_charter_store', 'dots/guardian.json'],
    ['dot_charter_store', 'knowledge/confidential/' + tenantA + '/dots/guardian.json'],
    ['dot_lifecycle_runtime_store', 'active/shared/runtime/dot-lifecycle-audit.jsonl'],
    ['dot_lifecycle_runtime_store', 'active/shared/runtime/heartbeats/dot-guardian.json'],
    ['dot_lifecycle_runtime_store', eventsPath(tenantA)],
    ['dot_lifecycle_runtime_store', continuationPath(tenantA)],
  ])('%s can write its declared purpose path %s', (role, target) => {
    expectDecision(
      assume(role, () => validateWritePermission(at(target))),
      true
    );
    expectDecision(
      assume(role, () => validateReadPermission(at(target))),
      true
    );
  });

  it.each([
    ['dot_charter_store', 'active/shared/runtime/heartbeats/dot-guardian.json'],
    ['dot_charter_store', 'dots/readme.txt'],
    ['dot_charter_store', 'dots/nested/guardian.json'],
    ['dot_charter_store', 'knowledge/confidential/' + tenantA + '/unrelated.json'],
    ['dot_lifecycle_runtime_store', 'dots/guardian.json'],
    ['dot_lifecycle_runtime_store', 'knowledge/confidential/' + tenantA + '/dots/guardian.json'],
    ['dot_lifecycle_runtime_store', 'active/shared/runtime/unrelated-queue.jsonl'],
    [
      'dot_lifecycle_runtime_store',
      'active/shared/runtime/dot/confidential/' + tenantA + '/work-results.jsonl',
    ],
    ['dot_lifecycle_runtime_store', 'active/shared/runtime/locks/other.lock'],
  ])('%s cannot write outside its purpose: %s', (role, target) => {
    expectDecision(
      assume(role, () => validateWritePermission(at(target))),
      false
    );
  });

  it.each(roles)('%s retains the active tenant boundary', (role) => {
    const target =
      role === 'dot_charter_store'
        ? 'knowledge/confidential/' + tenantB + '/dots/guardian.json'
        : eventsPath(tenantB);
    expectDecision(
      assume(role, () => validateWritePermission(at(target))),
      false
    );
    expectDecision(
      assume(role, () => validateReadPermission(at(target))),
      false
    );
  });

  it('does not turn cleared runtime custody into access to confidential tenants', () => {
    assume(
      'dot_lifecycle_runtime_store',
      () => {
        expect(currentExecutionScope()?.tenantCleared).toBe(true);
        for (const tenant of [tenantA, tenantB]) {
          const dir = 'active/shared/runtime/dot/confidential/' + tenant;
          const file = eventsPath(tenant);
          expectDecision(validateReadPermission(at(file)), false);
          expectDecision(validateReadPermission(at(dir), 'metadata'), false);
          expectDecision(validateWritePermission(at(file)), false);
          expectDecision(validateWritePermission(at(file), 'append'), false);
          expectDecision(validateWritePermission(at(dir), 'mkdir'), false);
        }
      },
      ''
    );
  });

  it('allows append to the lifecycle ledger and bound event ledger', () => {
    assume('dot_lifecycle_runtime_store', () => {
      for (const target of ['active/shared/runtime/dot-lifecycle-audit.jsonl', eventsPath(tenantA)])
        expectDecision(validateWritePermission(at(target), 'append'), true);
    });
  });

  it.each([
    'knowledge/personal/private-note.txt',
    'knowledge/personal/dots/fixture-owner/guardian.json',
    'knowledge/confidential/' + tenantA + '/private-note.txt',
    'knowledge/confidential/' + tenantA + '/dots/guardian.json',
    'knowledge/confidential/' + tenantB + '/private-note.txt',
  ])('does not expose raw knowledge through runtime projection grants: %s', (target) => {
    assume('dot_lifecycle_runtime_store', () => {
      expectDecision(validateReadPermission(at(target)), false);
      expectDecision(validateReadPermission(at(target), 'metadata'), false);
      expectDecision(validateWritePermission(at(target)), false);
      expectDecision(validateWritePermission(at(target), 'append'), false);
    });
  });

  it.each([
    ['tenant-bound', eventsPath(tenantA), tenantA],
    ['personal', personalEventsPath, ''],
  ])(
    'writes and reads a cold canonical %s event file without persona elevation',
    (_label, target, tenant) => {
      assume(
        'dot_lifecycle_runtime_store',
        () => {
          expect(currentExecutionScope()?.assumedPersona).toBe('worker');
          expect(safeExistsSync(at(target))).toBe(false);
          const content = JSON.stringify({ event_id: 'synthetic-cold-event', payload: {} }) + '\n';
          safeWriteFile(at(target), content, { encoding: 'utf8' });
          expect(safeReadFile(at(target), { encoding: 'utf8' })).toBe(content);
        },
        tenant
      );
    }
  );

  it('refuses a runtime event symlink into raw personal knowledge without changing its bytes', () => {
    assume('dot_lifecycle_runtime_store', () => {
      expect(() => safeWriteFile(escapeAlias, 'attempted replacement')).toThrow();
    });
    vi.restoreAllMocks();
    expect(safeReadFile(escapeSource, { encoding: 'utf8' })).toBe(escapeContent);
  });

  it.each([
    ['dot_charter_store', 'knowledge/personal/dots/fixture-owner/guardian.json'],
    ['dot_charter_store', 'dots/guardian.json'],
    ['dot_lifecycle_runtime_store', personalEventsPath],
    ['dot_lifecycle_runtime_store', publicEventsPath],
  ])('%s explicitly clears ambient tenant for non-tenant custody %s', (role, target) => {
    assume(
      role,
      () => {
        expect(currentExecutionScope()?.tenantCleared).toBe(true);
        expect(currentExecutionScope()?.tenantSlug).toBeUndefined();
        expectDecision(validateWritePermission(at(target)), true);
      },
      ''
    );
  });

  it('refuses the retired writer as an assumed role and grants no ambient I/O', () => {
    expect(() => assume('dot_lifecycle_writer', () => undefined)).toThrow();
    vi.stubEnv('MISSION_ROLE', 'dot_lifecycle_writer');
    for (const target of [
      'dots/guardian.json',
      'active/shared/runtime/dot-lifecycle-audit.jsonl',
      'active/shared/runtime/heartbeats/dot-guardian.json',
    ]) {
      expectDecision(validateWritePermission(at(target)), false);
      expectDecision(validateReadPermission(at(target)), false);
      expectDecision(validateReadPermission(at(target), 'metadata'), false);
    }
  });
});
