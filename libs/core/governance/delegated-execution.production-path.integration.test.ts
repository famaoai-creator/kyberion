/** Production default authority paths, isolated from every real checkout's state. */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedFirstJobTestRoot } from '../../../scripts/fixtures/first-job-approval-fixture.js';
import { safeRmSync as removeFixture } from '../secure-io.js';
import { withExecutionContext as inSourceContext } from '../authority.js';
import type { DelegatedExecutionPolicy, DelegatedExecutionTarget } from './delegated-execution.js';

vi.mock('./approval-store-reader.js', () => ({ listApprovalRequests: () => [] }));
vi.mock('./approval-policy.js', () => ({
  resolveApprovalPolicy: () => ({
    requiresApproval: false,
    missingRequirements: [],
    mandatoryApproval: false,
  }),
}));
vi.mock('../organization/decision-rights.js', () => ({
  resolveDecisionRightsMatrix: () => ({}),
  evaluateDecisionRights: () => null,
}));

const sourceRoot = process.cwd();
const root = path.join(sourceRoot, 'active/shared/tmp', `delegated-production-${randomUUID()}`);
const NOW = new Date('2026-10-20T09:00:00Z');
const policy: DelegatedExecutionPolicy = {
  version: '1',
  operations: [
    {
      operation_id: 'enterprise:sign',
      decision_type: 'contract_signature',
      amount_path: ['contract', 'amount'],
      currency_path: ['contract', 'currency'],
      required_paths: [['contract', 'counterparty']],
      risk_level: 'low',
      max_ttl_seconds: 600,
    },
  ],
};
let authority: typeof import('../authority.js');
let io: typeof import('../secure-io.js');
let paths: typeof import('../path-resolver.js');
let tenants: typeof import('../organization/tenant-registry.js');
let charters: typeof import('./accountability-charter-registry.js');
let delegated: typeof import('./delegated-execution.js');
let actor: typeof import('../contracts/actor.js');

beforeAll(async () => {
  seedFirstJobTestRoot(sourceRoot, root);
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.stubEnv('KYBERION_PERSONA', 'ecosystem_architect');
  for (const key of [
    'SYSTEM_ROLE',
    'MISSION_ID',
    'KYBERION_TENANT',
    'KYBERION_TASK_ID',
    'KYBERION_ORGANIZATION_ID',
    'KYBERION_PROJECT_ID',
    'KYBERION_SUDO',
    'KYBERION_STANCE',
    'KYBERION_CUSTOMER',
  ])
    vi.stubEnv(key, '');
  // Root selection is import-bound, including storeRelativePath. A namespace
  // spy alone cannot isolate the production route in a linked worktree.
  vi.resetModules();
  authority = await import('../authority.js');
  io = await import('../secure-io.js');
  paths = await import('../path-resolver.js');
  tenants = await import('../organization/tenant-registry.js');
  charters = await import('./accountability-charter-registry.js');
  delegated = await import('./delegated-execution.js');
  actor = await import('../contracts/actor.js');
}, 60000);

afterAll(() => {
  process.chdir(sourceRoot);
  vi.unstubAllEnvs();
  // The entire fixture is owned scratch. Never delete a tenant parent under
  // a real primary checkout as cleanup for a default-root assertion.
  inSourceContext('ecosystem_architect', () =>
    removeFixture(root, { recursive: true, force: true })
  );
  vi.resetModules();
});

describe('default-path delegated execution with actual protected stores', () => {
  it.each(['organization_operator', 'infrastructure_sentinel', 'mission_controller'])(
    'keeps production %s authority scoped to the owned charter ledger',
    async (role) => {
      const tenant = `delegation-${randomUUID().slice(0, 8)}`;
      const scope = { kind: 'organization', tenant_slug: tenant } as const;
      expect(paths.rootDir()).toBe(root);
      expect(paths.primaryCheckoutRootDir()).toBe(root);
      const actualDirectory = charters.charterDir(scope);
      expect(actualDirectory).toBe(path.join(root, 'knowledge/confidential', tenant, 'charters'));
      expect(paths.storeRelativePath(actualDirectory)).toBe(
        `knowledge/confidential/${tenant}/charters`
      );
      const charter = authority.withExecutionContext(
        'mission_controller',
        () => {
          tenants.writeTenantProfile({
            tenant_slug: tenant,
            display_name: 'Synthetic delegated execution tenant',
            status: 'active',
            assigned_role: 'owner',
          });
          return charters.acceptCharter({
            draft: {
              charter_id: 'chr-production-delegation',
              scope,
              accountable: {
                actor: 'user:owner',
                authority_basis: { kind: 'officer', evidence_ref: 'registry' },
                expires_at: '2026-12-31T00:00:00Z',
                deputies: [],
              },
              envelope: {
                money: { currency: 'JPY', per_action: 100, per_day: 100, per_month: 100 },
                data_tier: { read: [], write: [] },
                external_effects: { sign_contract: 'allow', payment: 'allow' },
                irreversible: 'named_actions_only',
                irreversible_named_actions: ['contract_signature'],
              },
              appetite: {
                max_loss_per_incident: 100,
                reputational_class_max: 'D',
                blast_radius_max: { recipients: 5, systems: 5 },
                tripwires: ['fraud'],
              },
            },
            statement: 'I accept responsibility.',
            acceptedBy: actor.humanActor('owner'),
            validation: { holder_role: 'owner' },
            now: NOW,
          });
        },
        'ecosystem_architect',
        tenant
      );
      const target: DelegatedExecutionTarget = {
        operationId: 'enterprise:sign',
        params: {
          amount: 1,
          contract: { amount: 60, currency: 'JPY', counterparty: 'vendor:123' },
        },
        tenantSlug: tenant,
        agentId: 'worker-1',
        callerRole: 'owner',
        source: { missionId: 'mission-1', taskId: 'task-1' },
        stepId: 'sign',
        correlationId: 'invoice-1',
      };
      const options = {
        rootDir: undefined,
        policy,
        now: NOW,
        availability: { accountable_available: true, available_deputies: [] },
      };
      // Acceptance and evaluation share an explicit clock, not CI wall time.
      expect(charters.findActiveCharter(scope, new Date(NOW.getTime() - 1))).toBeNull();
      expect(charters.findActiveCharter(scope, NOW)?.accountable.accepted_at).toBe(
        NOW.toISOString()
      );
      expect(charters.findActiveCharter(scope, new Date(NOW.getTime() + 1))?.charter_id).toBe(
        charter.charter_id
      );
      await authority.withExecutionContextAsync(
        role,
        async () => {
          const effect = vi.fn(async () => {
            expect(authority.resolveRole()).toBe(role);
            return 'ok';
          });
          await expect(delegated.runDelegatedExecution(target, effect, options)).resolves.toBe(
            'ok'
          );
          expect(effect).toHaveBeenCalledOnce();
          expect(() =>
            io.safeWriteFile(path.join(actualDirectory, `${charter.charter_id}.json`), '{}')
          ).toThrow();
          expect(() =>
            io.safeWriteFile(path.join(actualDirectory, 'unrelated.json'), '{}')
          ).toThrow();
        },
        'worker',
        tenant
      );
      await authority.withExecutionContextAsync(
        role,
        async () => {
          await expect(
            delegated.runDelegatedExecution(target, async () => 'bad', options)
          ).rejects.toThrow();
        },
        'worker',
        'foreign-tenant'
      );
    }
  );
});
