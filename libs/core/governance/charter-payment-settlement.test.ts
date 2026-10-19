import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentActor, humanActor } from '../actor.js';
import * as pathResolver from '../path-resolver.js';
import { safeReaddir, safeRmSync } from '../secure-io.js';
import { appendJsonLine } from '../foundation/json.js';
import {
  acceptCharter,
  charterDir,
  loadCharterUsage,
  readCharterLedger,
} from './accountability-charter-registry.js';
import { buildAccountabilityReport } from './accountability-report.js';
import {
  executeCharterPayment,
  readCharterPayment,
  reconcileCharterPayment,
  type CharterPaymentAdapter,
  type CharterPaymentExecution,
  type CharterPaymentReceipt,
  type CharterPaymentResolution,
  type ExecuteCharterPaymentInput,
} from './charter-payment-settlement.js';

vi.mock('./approval-policy.js', () => ({
  resolveApprovalPolicy: vi.fn(() => ({
    requiresApproval: false,
    missingRequirements: [],
  })),
}));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('./governance-action-recorder.js', () => ({ recordGovernanceAction: vi.fn() }));
vi.mock('../surface/operator-notifications.js', () => ({ notifyOperator: vi.fn() }));

const NOW = new Date('2026-10-20T09:00:00Z');
const scope = { kind: 'organization', tenant_slug: 'payment-test' } as const;
const receipt = (
  p: Readonly<CharterPaymentExecution>,
  resolution: CharterPaymentResolution
): CharterPaymentReceipt => ({
  ...p,
  resolution,
  evidence_ref: `provider:receipt:${resolution}`,
  execution_closed: true,
});

describe('governed payment execution and settlement', () => {
  let root: string;
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  let charter: ReturnType<typeof acceptCharter>;
  const opts = () => ({ rootDir: root });
  const adapter = (resolution: CharterPaymentResolution = 'succeeded'): CharterPaymentAdapter => ({
    id: 'provider:account-1',
    execute: vi.fn(async (p) => receipt(p, resolution)),
    reconcile: vi.fn(async (p) => receipt(p, resolution)),
  });
  const input = (
    a: CharterPaymentAdapter,
    payment_id = 'invoice-1'
  ): ExecuteCharterPaymentInput => ({
    adapter: a,
    intent: { payment_id, recipient: 'vendor:123', description: 'Invoice 123' },
    gate: {
      agentId: 'worker-1',
      operationId: 'provider:pay',
      now: NOW,
      charter: {
        scope,
        pathOptions: opts(),
        action: {
          actor: agentActor('kyberion://agent/payment-test/worker', 'user:owner'),
          action_class: 'payment',
          amount: 60,
          currency: 'JPY',
          reversible: false,
          irreversible_action_name: 'operational_spend',
          estimated_loss: 60,
        },
      },
    },
  });
  const usage = (date = NOW) => loadCharterUsage(charter, date, opts()).spent_today;

  beforeEach(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active/shared/tmp',
      `payment-settlement-${randomUUID()}`
    );
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    charter = acceptCharter(
      {
        draft: {
          charter_id: 'chr-payments-1',
          scope,
          accountable: {
            actor: 'user:owner',
            authority_basis: { kind: 'officer', evidence_ref: 'registry-extract' },
            expires_at: '2026-12-31T00:00:00Z',
            deputies: [],
          },
          envelope: {
            money: { currency: 'JPY', per_action: 100, per_day: 100, per_month: 100 },
            data_tier: { read: [], write: [] },
            external_effects: { payment: 'allow' },
            irreversible: 'named_actions_only',
            irreversible_named_actions: ['operational_spend'],
          },
          appetite: {
            max_loss_per_incident: 100,
            reputational_class_max: 'D',
            blast_radius_max: { recipients: 1, systems: 1 },
            tripwires: [],
          },
        },
        statement: 'I accept responsibility.',
        acceptedBy: humanActor('owner'),
        validation: { holder_role: 'owner' },
        now: NOW,
      },
      opts()
    );
  });
  afterEach(() => {
    safeRmSync(root, { recursive: true, force: true });
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
  });

  it('executes once and reserves once across concurrent/repeated calls', async () => {
    const a = adapter();
    const [one, duplicate] = await Promise.all([
      executeCharterPayment(input(a)),
      executeCharterPayment(input(a)),
    ]);
    expect(one.status).toBe('succeeded');
    expect(['authorizing', 'executing', 'succeeded']).toContain(duplicate.status);
    expect((await executeCharterPayment(input(a))).status).toBe('succeeded');
    expect(a.execute).toHaveBeenCalledTimes(1);
    expect(usage()).toBe(60);
    expect(readCharterLedger(charter, opts()).filter((e) => e.kind === 'consumption')).toHaveLength(
      1
    );
    expect((await executeCharterPayment(input(a, 'invoice-2'))).status).toBe('blocked');
    expect(a.execute).toHaveBeenCalledTimes(1);
  });

  it('binds identity to amount, recipient, actor and original provider', async () => {
    const a = adapter();
    await executeCharterPayment(input(a));
    const changed = input(a);
    changed.gate.charter.action.amount = 20;
    await expect(executeCharterPayment(changed)).rejects.toThrow('identity reused');
    const changedActor = input(a);
    changedActor.gate.charter.action.actor = agentActor(
      'kyberion://agent/payment-test/other',
      'user:owner'
    );
    await expect(executeCharterPayment(changedActor)).rejects.toThrow('identity reused');
    await expect(
      executeCharterPayment({ ...input(a), intent: { ...input(a).intent, recipient: 'other' } })
    ).rejects.toThrow('identity reused');
    await expect(
      reconcileCharterPayment(scope, 'invoice-1', { ...a, id: 'other-provider' }, opts())
    ).rejects.toThrow('not found');
    await expect(
      reconcileCharterPayment(
        { kind: 'organization', tenant_slug: 'other-tenant' },
        'invoice-1',
        a,
        opts()
      )
    ).rejects.toThrow('not found');
  });

  it('reauthorizes a previously blocked invoice only under a newly human-accepted charter', async () => {
    const a = adapter();
    await executeCharterPayment(input(a, 'invoice-first'));
    expect((await executeCharterPayment(input(a, 'invoice-blocked'))).status).toBe('blocked');
    expect((await executeCharterPayment(input(a, 'invoice-blocked'))).status).toBe('blocked');
    expect(a.execute).toHaveBeenCalledTimes(1);
    charter = acceptCharter(
      {
        draft: {
          ...charter,
          charter_id: 'chr-payments-amended',
          envelope: {
            ...charter.envelope,
            money: { currency: 'JPY', per_action: 100, per_day: 200, per_month: 200 },
          },
        },
        replaces: charter.charter_id,
        statement: 'I accept the revised delegation.',
        acceptedBy: humanActor('owner'),
        validation: { holder_role: 'owner' },
        now: NOW,
      },
      opts()
    );
    expect((await executeCharterPayment(input(a, 'invoice-blocked'))).status).toBe('succeeded');
    expect((await executeCharterPayment(input(a, 'invoice-blocked'))).status).toBe('succeeded');
    expect(a.execute).toHaveBeenCalledTimes(2);
    expect((await executeCharterPayment(input(a, 'invoice-first'))).status).toBe('succeeded');
    expect(a.execute).toHaveBeenCalledTimes(2);
    expect(usage()).toBe(60);
  });

  it('preserves unknown spend on transport failure and never retries execution', async () => {
    const a = adapter('unknown');
    a.execute = vi.fn(async () => {
      throw new Error('connection lost after submission');
    });
    expect((await executeCharterPayment(input(a))).status).toBe('unknown');
    expect((await executeCharterPayment(input(a))).status).toBe('unknown');
    expect(a.execute).toHaveBeenCalledTimes(1);
    expect(usage()).toBe(60);
    await reconcileCharterPayment(scope, 'invoice-1', a, opts());
    expect(usage()).toBe(60);
    a.reconcile = vi.fn(async (p) => receipt(p, 'succeeded'));
    expect((await reconcileCharterPayment(scope, 'invoice-1', a, opts())).status).toBe('succeeded');
    expect(usage()).toBe(60);
  });

  it('releases only full authoritative compensation and only once in the original budget period', async () => {
    const a = adapter();
    await executeCharterPayment(input(a));
    a.reconcile = vi.fn(async (p) => receipt(p, 'compensated'));
    await reconcileCharterPayment(scope, 'invoice-1', a, opts());
    await reconcileCharterPayment(scope, 'invoice-1', a, opts());
    await executeCharterPayment(input(a));
    expect(usage()).toBe(0);
    expect(usage(new Date('2026-10-21T10:00:00Z'))).toBe(0);
    expect(
      buildAccountabilityReport({ charter, ledger: readCharterLedger(charter, opts()), now: NOW })
        .money.spent_today
    ).toBe(0);
    expect(
      readCharterLedger(charter, opts()).filter((e) => e.kind === 'reservation_release')
    ).toHaveLength(1);
    expect(a.execute).toHaveBeenCalledTimes(1);
  });

  it('does not release partial spend, a transient not-found query, or mismatched receipts', async () => {
    const a = adapter('partial');
    await executeCharterPayment(input(a));
    a.reconcile = vi.fn(async (p) => receipt(p, 'not_executed'));
    expect((await reconcileCharterPayment(scope, 'invoice-1', a, opts())).status).toBe('partial');
    expect(usage()).toBe(60);
    a.reconcile = vi.fn(async (p) => receipt(p, 'unknown'));
    expect((await reconcileCharterPayment(scope, 'invoice-1', a, opts())).status).toBe('partial');
    a.reconcile = vi.fn(async (p) => receipt(p, 'not_executed'));
    expect((await reconcileCharterPayment(scope, 'invoice-1', a, opts())).status).toBe('partial');
    a.reconcile = vi.fn(async (p) => ({ ...receipt(p, 'compensated'), amount: 1 }));
    await expect(reconcileCharterPayment(scope, 'invoice-1', a, opts())).rejects.toThrow(
      'full payment intent'
    );
    expect(usage()).toBe(60);
  });

  it('rejects a non-final not-found reconciliation while execution is in flight', async () => {
    let complete!: (r: CharterPaymentReceipt) => void;
    let submitted!: Readonly<CharterPaymentExecution>;
    const a = adapter();
    a.execute = vi.fn((p) => {
      submitted = p;
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const running = executeCharterPayment(input(a));
    expect(readCharterPayment(scope, 'invoice-1', opts())?.status).toBe('executing');
    a.reconcile = vi.fn(async (p) => ({ ...receipt(p, 'not_executed'), execution_closed: false }));
    await expect(reconcileCharterPayment(scope, 'invoice-1', a, opts())).rejects.toThrow(
      'permanent execution closure'
    );
    expect(usage()).toBe(60);
    complete(receipt(submitted, 'succeeded'));
    expect((await running).status).toBe('succeeded');
    expect(usage()).toBe(60);
  });

  it('fails closed on valid-JSON corruption instead of losing a durable claim', async () => {
    const a = adapter();
    await executeCharterPayment(input(a));
    const dir = charterDir(scope, opts());
    const file = safeReaddir(dir).find((name) => name.endsWith('.payment.jsonl'))!;
    appendJsonLine(path.join(dir, file), null);
    await expect(executeCharterPayment(input(a))).rejects.toThrow('corrupt durable payment state');
    expect(a.execute).toHaveBeenCalledTimes(1);
    expect(usage()).toBe(60);
  });
});
