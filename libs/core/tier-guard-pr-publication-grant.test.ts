import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { resetRoleAssumptionPolicyCache, resolveRole, withExecutionContext } from './authority.js';
import { currentExecutionScope } from './foundation/execution-scope.js';
import { inspectReadPermission, validateWritePermission } from './tier-guard.js';
import {
  withPrPublicationRuntime,
  withPrPublicationStoreAccess,
} from './governance/pr-publication-runtime.js';

// G2: the live PR publication grant is the authority; there is no store role.
vi.mock('./governance/audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));

const ROOT = pathResolver.rootDir();
const ENV_KEYS = [
  'KYBERION_TENANT',
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'KYBERION_SUDO',
  'MISSION_ID',
  'KYBERION_TENANT_SCOPE_REQUIRED',
  'KYBERION_ORGANIZATION_ID',
] as const;
const at = (relative: string) => path.join(ROOT, relative);
const invocation = 'a'.repeat(64);
const hash = 'b'.repeat(64);
const acme = { kind: 'organization' as const, tenant_slug: 'acme' };
const ledger = 'knowledge/confidential/acme/charters/chr-one.ledger.jsonl';
const review = `active/shared/artifacts/confidential/acme/evidence/pr-publication/${invocation}/${hash}.json`;
const index = 'active/shared/artifacts/confidential/acme/artifacts-index.jsonl';
const reservation = `active/shared/runtime/external-operations/personal/shared/${hash}.json`;
const allowed = (decision: { allowed: boolean }) => decision.allowed;
const ledgerGrant = <T>(fn: () => T): T =>
  withPrPublicationRuntime(acme, invocation, () =>
    withPrPublicationStoreAccess('charter-ledger-write', [ledger], [ledger], fn)
  );

describe('tier-guard PR publication grant (no store role)', () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    resetRoleAssumptionPolicyCache();
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetRoleAssumptionPolicyCache();
  });

  it('authorizes exactly its ceiling for a caller without any role, and nothing after it ends', () => {
    expect(allowed(validateWritePermission(at(ledger), 'append'))).toBe(false);
    ledgerGrant(() => {
      expect(resolveRole()).not.toBe('pr_publication_store');
      expect(allowed(validateWritePermission(at(ledger), 'append'))).toBe(true);
      expect(allowed(validateWritePermission(at(ledger), 'write'))).toBe(true);
      expect(allowed(inspectReadPermission(at(ledger), 'read'))).toBe(true);
      for (const other of [
        'knowledge/confidential/acme/charters/chr-one.json',
        'knowledge/confidential/acme/charters/chr-two.ledger.jsonl',
        'knowledge/confidential/other/charters/chr-one.ledger.jsonl',
        'knowledge/confidential/acme/secret.json',
      ]) {
        expect(allowed(validateWritePermission(at(other), 'append')), other).toBe(false);
        expect(allowed(inspectReadPermission(at(other), 'read')), other).toBe(false);
      }
    });
    expect(allowed(validateWritePermission(at(ledger), 'append'))).toBe(false);
  });

  it('narrows a broad caller to the grant ceiling while it is active', () => {
    process.env.MISSION_ROLE = 'mission_controller';
    const outside = 'active/shared/runtime/missions/state.json';
    const before = allowed(validateWritePermission(at(outside)));
    ledgerGrant(() => {
      expect(allowed(validateWritePermission(at(outside)))).toBe(false);
      expect(validateWritePermission(at(outside)).reason).toContain('[PR_PUBLICATION_SCOPE]');
    });
    expect(allowed(validateWritePermission(at(outside)))).toBe(before);
  });

  it('creates the confidential artifact container only for its own organization tenant', () => {
    withPrPublicationRuntime(acme, invocation, () =>
      withPrPublicationStoreAccess('review-write', [review, index], [review, index], () => {
        expect(allowed(validateWritePermission(at(review)))).toBe(true);
        expect(allowed(validateWritePermission(at(index), 'append'))).toBe(true);
        expect(
          allowed(validateWritePermission(at('active/shared/artifacts/confidential'), 'mkdir'))
        ).toBe(true);
      })
    );
    withPrPublicationRuntime({ kind: 'person' }, invocation, () =>
      withPrPublicationStoreAccess('reservation-write', [], [reservation], () => {
        expect(allowed(validateWritePermission(at(reservation)))).toBe(true);
        expect(
          allowed(
            validateWritePermission(
              at('active/shared/runtime/external-operations/confidential'),
              'mkdir'
            )
          )
        ).toBe(false);
      })
    );
  });

  it('refuses the former role name as an assumable role', () => {
    expect(() => withExecutionContext('pr_publication_store', () => undefined, 'worker')).toThrow(
      '[ROLE_ASSUMPTION_DENIED]'
    );
  });

  it('keeps who may issue: a SYSTEM_ROLE without a policy entry is refused before its callback', () => {
    process.env.SYSTEM_ROLE = 'zz_unlisted_surface';
    const callback = vi.fn();
    expect(() => ledgerGrant(callback)).toThrow('[ROLE_ASSUMPTION_DENIED]');
    expect(callback).not.toHaveBeenCalled();
    process.env.SYSTEM_ROLE = 'slack_bridge';
    resetRoleAssumptionPolicyCache();
    expect(ledgerGrant(() => allowed(validateWritePermission(at(ledger), 'append')))).toBe(true);
  });

  it('binds the organization tenant, refuses another bound tenant and leaves person unbound', () => {
    withExecutionContext(
      'mission_controller',
      () => {
        ledgerGrant(() => {
          expect(currentExecutionScope()?.tenantSlug).toBe('acme');
          expect(currentExecutionScope()?.organizationId).toBeUndefined();
          expect(resolveRole()).toBe('mission_controller');
        });
      },
      undefined,
      'acme',
      'org-1'
    );
    const callback = vi.fn();
    withExecutionContext(
      'mission_controller',
      () => expect(() => ledgerGrant(callback)).toThrow('[ROLE_TENANT_SCOPE_MISMATCH]'),
      undefined,
      'other'
    );
    expect(callback).not.toHaveBeenCalled();
    withExecutionContext(
      'mission_controller',
      () =>
        withPrPublicationRuntime({ kind: 'person' }, invocation, () =>
          withPrPublicationStoreAccess('reservation-write', [], [reservation], () => {
            expect(currentExecutionScope()?.tenantBound).toBe(false);
            expect(currentExecutionScope()?.tenantSlug).toBeUndefined();
            expect(allowed(validateWritePermission(at(reservation)))).toBe(true);
          })
        ),
      undefined,
      'other'
    );
  });
});
