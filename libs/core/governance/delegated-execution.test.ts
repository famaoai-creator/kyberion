import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRole, withExecutionContextAsync } from '../authority.js';
import { humanActor } from '../actor.js';
import * as pathResolver from '../path-resolver.js';
import { safeRmSync, safeWriteFile } from '../secure-io.js';
import {
  acceptCharter,
  loadCharterUsage,
  recordTripwire,
  retireCharter,
  readCharterLedger,
  charterDir,
} from './accountability-charter-registry.js';
import {
  delegatedExecutionIdentity,
  authorizeDelegatedExecution,
  currentDelegatedExecution,
  runDelegatedExecution,
  verifyDelegatedExecution,
  type DelegatedExecutionPolicy,
  type DelegatedExecutionTarget,
} from './delegated-execution.js';

const mocks = vi.hoisted(() => ({
  mandatory: false,
  escalates: false,
  humanClaims: [] as unknown[],
}));
vi.mock('./approval-store-reader.js', () => ({ listApprovalRequests: () => mocks.humanClaims }));
vi.mock('./approval-policy.js', () => ({
  resolveApprovalPolicy: () => ({
    requiresApproval: false,
    missingRequirements: [],
    mandatoryApproval: mocks.mandatory,
  }),
}));
vi.mock('../decision-rights.js', () => ({
  resolveDecisionRightsMatrix: () => ({}),
  evaluateDecisionRights: () =>
    mocks.escalates ? { requiresEscalation: true, escalationKind: 'role_mismatch' } : null,
}));

const NOW = new Date('2026-10-20T09:00:00Z');
const scope = { kind: 'organization', tenant_slug: 'delegation-test' } as const;
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
const target = (): DelegatedExecutionTarget => ({
  operationId: 'enterprise:sign',
  params: { amount: 1, contract: { amount: 60, currency: 'JPY', counterparty: 'vendor:123' } },
  tenantSlug: scope.tenant_slug,
  agentId: 'worker-1',
  callerRole: 'owner',
  source: { missionId: 'mission-1', taskId: 'task-1' },
  stepId: 'sign',
  correlationId: 'invoice-1',
});

describe('operation-bound delegated execution', () => {
  let root: string;
  let charter: ReturnType<typeof acceptCharter>;
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  const options = () => ({
    rootDir: root,
    policy,
    now: NOW,
    availability: { accountable_available: true, available_deputies: [] },
  });
  it('fences human claims before issuance and again before the delegated effect claim', async () => {
    const effect = vi.fn(async () => 'paid');
    const humanClaim = {
      scope: { tenant_slug: scope.tenant_slug },
      requestedByContext: { executionIdentity: delegatedExecutionIdentity(target()) },
      applyClaim: { claimId: 'uncertain-human' },
    };
    mocks.humanClaims = [humanClaim];
    expect(authorizeDelegatedExecution(target(), options())).toMatchObject({ allowed: false });
    mocks.humanClaims = [];
    expect(authorizeDelegatedExecution(target(), options()).allowed).toBe(true);
    mocks.humanClaims = [humanClaim];
    await expect(runDelegatedExecution(target(), effect, options())).rejects.toThrow(
      'RECONCILIATION_REQUIRED'
    );
    expect(effect).not.toHaveBeenCalled();
  });
  it('rechecks a human winner after issuance before publishing the charter execution claim', async () => {
    const effect = vi.fn(async () => 'executed');
    let scans = 0;
    Object.defineProperty(mocks, 'humanClaims', {
      configurable: true,
      get: () => {
        scans++;
        return scans < 2
          ? []
          : [
              {
                scope: { tenant_slug: scope.tenant_slug },
                requestedByContext: { executionIdentity: delegatedExecutionIdentity(target()) },
                applyClaim: { claimId: 'human-winner' },
              },
            ];
      },
      set: () => {},
    });
    try {
      await expect(runDelegatedExecution(target(), effect, options())).rejects.toThrow(
        'RECONCILIATION_REQUIRED'
      );
      expect(effect).not.toHaveBeenCalled();
      expect(
        readCharterLedger(charter, options())
          .filter((entry) => entry.kind === 'delegated_execution')
          .map((entry) => entry.state)
      ).toEqual(['issued']);
    } finally {
      Object.defineProperty(mocks, 'humanClaims', {
        configurable: true,
        writable: true,
        value: [],
      });
    }
  });
  it.each(['organization_operator', 'infrastructure_sentinel', 'mission_controller'])(
    'executes with production %s worker authority against actual protected charter paths',
    async (role) => {
      const tenant = `delegation-${randomUUID().slice(0, 8)}`;
      const productionScope = { kind: 'organization', tenant_slug: tenant } as const;
      const productionOptions = { ...options(), rootDir: undefined };
      const productionTarget = { ...target(), tenantSlug: tenant };
      const actualDirectory = charterDir(productionScope);
      try {
        acceptCharter(
          {
            draft: {
              charter_id: charter.charter_id,
              scope: productionScope,
              accountable: charter.accountable,
              envelope: charter.envelope,
              appetite: charter.appetite,
            },
            statement: 'I accept responsibility.',
            acceptedBy: humanActor('owner'),
            validation: { holder_role: 'owner' },
          },
          {},
          NOW
        );
        await withExecutionContextAsync(
          role,
          async () => {
            const effect = vi.fn(async () => {
              expect(resolveRole()).toBe(role);
              return 'ok';
            });
            await expect(
              runDelegatedExecution(productionTarget, effect, productionOptions)
            ).resolves.toBe('ok');
            expect(effect).toHaveBeenCalledOnce();
            expect(() =>
              safeWriteFile(path.join(actualDirectory, `${charter.charter_id}.json`), '{}')
            ).toThrow();
            expect(() =>
              safeWriteFile(path.join(actualDirectory, 'unrelated.json'), '{}')
            ).toThrow();
          },
          'worker',
          tenant
        );
        await withExecutionContextAsync(
          role,
          async () => {
            await expect(
              runDelegatedExecution(productionTarget, async () => 'bad', productionOptions)
            ).rejects.toThrow();
          },
          'worker',
          'foreign-tenant'
        );
      } finally {
        safeRmSync(path.dirname(actualDirectory), { recursive: true, force: true });
      }
    }
  );
  beforeEach(() => {
    root = path.join(pathResolver.rootDir(), 'active/shared/tmp', `delegation-${randomUUID()}`);
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    mocks.humanClaims = [];
    mocks.mandatory = false;
    mocks.escalates = false;
    charter = acceptCharter(
      {
        draft: {
          charter_id: 'chr-delegation-1',
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
        acceptedBy: humanActor('owner'),
        validation: { holder_role: 'owner' },
        now: NOW,
      },
      { rootDir: root }
    );
  });
  afterEach(() => {
    safeRmSync(root, { recursive: true, force: true });
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
  });

  it('binds actual nested amount and reserves once across authorization/resume', () => {
    const request = target();
    const authorized = authorizeDelegatedExecution(request, options());
    expect(authorized.allowed).toBe(true);
    expect(authorizeDelegatedExecution(JSON.parse(JSON.stringify(request)), options())).toEqual(
      authorized
    );
    expect(
      verifyDelegatedExecution({ ...request, permitId: authorized.permitId! }, options())
    ).toBe(true);
    expect(loadCharterUsage(charter, NOW, { rootDir: root }).spent_today).toBe(60);
    expect(
      readCharterLedger(charter, { rootDir: root }).filter((e) => e.kind === 'consumption')
    ).toHaveLength(1);
    const oversized = target();
    (oversized.params.contract as Record<string, unknown>).amount = 1000;
    oversized.stepId = 'different-step';
    oversized.correlationId = 'different-request';
    expect(authorizeDelegatedExecution(oversized, options()).allowed).toBe(false);
    expect(
      verifyDelegatedExecution({ ...oversized, permitId: authorized.permitId! }, options())
    ).toBe(false);
  });

  it('requires trusted availability for irreversible delegation instead of assuming a human is present', () => {
    const { availability: _availability, ...unknownAvailability } = options();
    expect(authorizeDelegatedExecution(target(), unknownAvailability).reason).toContain(
      'safe_mode'
    );
  });

  it('stops on an orphan reservation after a crash and never reserves the budget twice', () => {
    expect(authorizeDelegatedExecution(target(), options()).allowed).toBe(true);
    const entries = readCharterLedger(charter, { rootDir: root }).filter(
      (entry) => entry.kind !== 'delegated_execution'
    );
    safeWriteFile(
      path.join(charterDir(scope, { rootDir: root }), `${charter.charter_id}.ledger.jsonl`),
      entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    );
    expect(authorizeDelegatedExecution(target(), options()).reason).toContain('orphaned');
    expect(loadCharterUsage(charter, NOW, { rootDir: root }).spent_today).toBe(60);
    expect(
      readCharterLedger(charter, { rootDir: root }).filter((entry) => entry.kind === 'consumption')
    ).toHaveLength(1);
  });

  it('rejects actor, tenant, source, operation, payload and step substitutions', () => {
    const request = target();
    const permitId = authorizeDelegatedExecution(request, options()).permitId!;
    for (const changed of [
      { ...request, agentId: 'other' },
      { ...request, tenantSlug: 'other' },
      { ...request, source: { missionId: 'other' } },
      { ...request, stepId: 'other' },
      { ...request, operationId: 'other:sign' },
      { ...request, params: {} },
    ])
      expect(verifyDelegatedExecution({ ...changed, permitId }, options())).toBe(false);
  });

  it('revalidates charter revocation, expiry, tripwires, policy and mapping at effect time', async () => {
    const request = target();
    const permitId = authorizeDelegatedExecution(request, options()).permitId!;
    expect(
      verifyDelegatedExecution(
        { ...request, permitId },
        { ...options(), now: new Date(NOW.getTime() + 601000) }
      )
    ).toBe(false);
    expect(
      verifyDelegatedExecution(
        { ...request, permitId },
        {
          ...options(),
          policy: { ...policy, operations: [{ ...policy.operations[0]!, risk_level: 'high' }] },
        }
      )
    ).toBe(false);
    mocks.mandatory = true;
    expect(verifyDelegatedExecution({ ...request, permitId }, options())).toBe(false);
    mocks.humanClaims = [];
    mocks.mandatory = false;
    mocks.escalates = true;
    expect(verifyDelegatedExecution({ ...request, permitId }, options())).toBe(false);
    mocks.escalates = false;
    recordTripwire(charter, 'fraud', 'suspicious charge', { rootDir: root }, NOW);
    const effect = vi.fn(async () => 'signed');
    await expect(runDelegatedExecution(request, effect, options())).rejects.toThrow(
      'DELEGATED_EXECUTION_DENIED'
    );
    expect(effect).not.toHaveBeenCalled();
    retireCharter(charter, humanActor('owner'), 'revoked', { rootDir: root }, NOW);
    expect(verifyDelegatedExecution({ ...request, permitId }, options())).toBe(false);
  });

  it('claims once under concurrency and shares opaque authorization with the nested effect', async () => {
    const request = target();
    let finish!: () => void;
    const effect = vi.fn(async () => {
      expect(currentDelegatedExecution(request.operationId, request.params)).toBeDefined();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return 'signed';
    });
    const first = runDelegatedExecution(request, effect, options());
    await expect(runDelegatedExecution(request, effect, options())).rejects.toThrow('replay');
    finish();
    expect(await first).toBe('signed');
    await expect(runDelegatedExecution(request, effect, options())).rejects.toThrow('replay');
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it('holds uncertain spend and forbids automatic retry after transport failure', async () => {
    const effect = vi.fn(async () => {
      throw new Error('response lost');
    });
    await expect(runDelegatedExecution(target(), effect, options())).rejects.toThrow(
      'response lost'
    );
    await expect(runDelegatedExecution(target(), effect, options())).rejects.toThrow('replay');
    const changed = target();
    (changed.params.contract as Record<string, unknown>).amount = 20;
    await expect(runDelegatedExecution(changed, effect, options())).rejects.toThrow('changed');
    expect(effect).toHaveBeenCalledTimes(1);
    expect(loadCharterUsage(charter, NOW, { rootDir: root }).spent_today).toBe(60);
  });

  it('keeps unknown operations and generic payments on the separate approval/executor path', () => {
    expect(
      authorizeDelegatedExecution({ ...target(), operationId: 'unknown:effect' }, options()).allowed
    ).toBe(false);
    expect(
      authorizeDelegatedExecution(target(), {
        ...options(),
        policy: {
          ...policy,
          operations: [{ ...policy.operations[0]!, decision_type: 'vendor_invoice_payment' }],
        },
      }).reason
    ).toContain('executeCharterPayment');
  });
});
