/**
 * End to end over the real pieces: call-site adapter → approval gate → charter
 * branch → registry + ledger, in a fixture root. Only persistence of approval
 * requests, the audit chain and outbound notifications are stubbed.
 */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./approval-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./approval-store.js')>()),
  createApprovalRequest: vi.fn(() => ({ id: 'req-1', status: 'pending' })),
  listApprovalRequests: vi.fn(() => []),
  lookupSessionApprovalCache: vi.fn(() => null),
  recordSessionCacheAutoApproval: vi.fn(),
}));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('./governance-action-recorder.js', () => ({ recordGovernanceAction: vi.fn() }));
vi.mock('../surface/operator-notifications.js', () => ({ notifyOperator: vi.fn() }));
vi.mock('../decision-rights.js', () => ({
  resolveDecisionRightsMatrix: vi.fn(() => null),
  evaluateDecisionRights: vi.fn(() => null),
}));
import { evaluateDecisionRights } from '../decision-rights.js';

import * as pathResolver from '../path-resolver.js';
import { humanActor } from '../actor.js';
import { safeRmSync } from '../secure-io.js';
import { enforceApprovalGate } from './approval-gate.js';
import { createApprovalRequest } from './approval-store.js';
import {
  acceptCharter,
  clearTripwire,
  findActiveCharter,
  loadCharterUsage,
  readCharterLedger,
  recordTripwire,
} from './accountability-charter-registry.js';
import { charterInputForDecision } from './charter-call-site.js';

const create = vi.mocked(createApprovalRequest);
const SCOPE = { kind: 'organization', tenant_slug: 'acme' } as const;

describe('accountability charter — end to end', () => {
  let root = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  const opts = () => ({ rootDir: root });
  const now = () => new Date();

  const spend = (amount: number, correlationId: string, tenantSlug = 'acme') => {
    const charter = charterInputForDecision(
      { tenantSlug, agentId: 'purchasing', decisionType: 'operational_spend', amount },
      opts()
    );
    expect(charter).toBeDefined();
    return enforceApprovalGate({
      operationId: 'spend.vendor',
      agentId: 'purchasing',
      correlationId,
      channel: 'mission',
      payload: { decision_type: 'operational_spend', amount },
      hasHuman: false, // an unattended pipeline: a human prompt cannot be raised
      charter: charter!,
    });
  };

  const draftFor = (tenant: string, supersede: boolean, start: Date) => ({
    charter_id: `chr-${tenant}-e2e`,
    scope: { kind: 'organization' as const, tenant_slug: tenant },
    accountable: {
      actor: 'user:owner',
      authority_basis: { kind: 'officer' as const, evidence_ref: 'registry-extract' },
      expires_at: new Date(start.getTime() + 30 * 86_400_000).toISOString(),
      deputies: ['user:carol'],
    },
    envelope: {
      money: { currency: 'JPY', per_action: 100_000, per_day: 150_000, per_month: 1_000_000 },
      data_tier: { read: [], write: [] },
      external_effects: { payment: 'allow' as const },
      irreversible: 'named_actions_only' as const,
      irreversible_named_actions: ['operational_spend'],
      ...(supersede ? { supersedes_decision_rights: true } : {}),
    },
    appetite: {
      max_loss_per_incident: 100_000,
      reputational_class_max: 'B' as const,
      blast_radius_max: { recipients: 1, systems: 1 },
      tripwires: ['audit-chain-gap'],
    },
  });

  beforeAll(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `charter-e2e-${randomUUID()}`
    );
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    const start = now();
    acceptCharter(
      {
        draft: {
          charter_id: 'chr-acme-e2e',
          scope: SCOPE,
          accountable: {
            actor: 'user:owner',
            authority_basis: { kind: 'officer', evidence_ref: 'registry-extract' },
            expires_at: new Date(start.getTime() + 30 * 86_400_000).toISOString(),
            deputies: ['user:carol'],
          },
          envelope: {
            money: { currency: 'JPY', per_action: 100_000, per_day: 150_000, per_month: 1_000_000 },
            data_tier: { read: [], write: [] },
            external_effects: { payment: 'allow' },
            irreversible: 'named_actions_only',
            irreversible_named_actions: ['operational_spend'],
          },
          appetite: {
            max_loss_per_incident: 100_000,
            reputational_class_max: 'B',
            blast_radius_max: { recipients: 1, systems: 1 },
            tripwires: ['audit-chain-gap'],
          },
        },
        statement: 'I am accountable.',
        acceptedBy: humanActor('owner'),
        validation: { holder_role: 'owner' },
        now: new Date(start.getTime() - 1000),
      },
      opts()
    );
  });
  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (root) safeRmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => create.mockClear());

  const charter = () => findActiveCharter(SCOPE, now(), opts())!;

  it('inside the envelope: an unattended pipeline is allowed with no approval, and the ledger shows the spend', () => {
    const r = spend(50_000, 'c-1');
    expect(r).toMatchObject({ allowed: true, status: 'not_required' });
    expect(r.message).toContain('user:owner');
    expect(create).not.toHaveBeenCalled();
    expect(loadCharterUsage(charter(), now(), opts()).spent_today).toBe(50_000);
  });

  it('a retried call with the same correlation id does not double-count', () => {
    expect(spend(50_000, 'c-1').allowed).toBe(true);
    expect(loadCharterUsage(charter(), now(), opts()).spent_today).toBe(50_000);
  });

  it('over the per-action limit: a human is required (here: blocked, since nobody is at the boundary) — nothing is consumed, the ask is recorded', () => {
    const before = loadCharterUsage(charter(), now(), opts()).spent_today;
    const r = spend(120_000, 'c-2');
    expect(r.allowed).toBe(false);
    expect(r.message).toContain('[HUMAN_REQUIRED]');
    expect(loadCharterUsage(charter(), now(), opts()).spent_today).toBe(before);
    const denied = readCharterLedger(charter(), opts()).filter((e) => e.kind === 'denied');
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ amendment_field: 'envelope.money.per_action' });
  });

  it('daily budget accumulates across calls and then requires a human', () => {
    expect(spend(60_000, 'c-3').allowed).toBe(true); // 50k + 60k = 110k of 150k
    const r = spend(50_000, 'c-4'); // would be 160k
    expect(r.allowed).toBe(false);
    expect(
      readCharterLedger(charter(), opts()).filter(
        (e) => e.kind === 'denied' && e.amendment_field === 'envelope.money.per_day'
      )
    ).toHaveLength(1);
  });

  it('a tripwire stops everything until the accountable human or a deputy clears it', () => {
    recordTripwire(charter(), 'audit-chain-gap', 'seq 41 missing', opts());
    const stopped = spend(1_000, 'c-5');
    expect(stopped.allowed).toBe(false);
    expect(stopped.message).toContain('[CHARTER_STOP]');
    expect(create).not.toHaveBeenCalled();
    clearTripwire(charter(), 'audit-chain-gap', humanActor('carol'), opts());
    expect(spend(1_000, 'c-6').allowed).toBe(true);
  });

  it('decision-rights matrix escalates: default charter defers to the matrix; a charter that explicitly supersedes it runs unattended', () => {
    const start = now();
    for (const [tenant, supersede] of [
      ['acme-plain', false],
      ['acme-sup', true],
    ] as const) {
      acceptCharter(
        {
          draft: draftFor(tenant, supersede, start),
          statement: 'I am accountable.',
          acceptedBy: humanActor('owner'),
          validation: { holder_role: 'owner' },
          now: new Date(start.getTime() - 1000),
        },
        opts()
      );
    }
    vi.mocked(evaluateDecisionRights).mockReturnValue({
      requiresEscalation: true,
      decisionType: 'operational_spend',
    } as never);
    try {
      const plain = spend(10_000, 'm-1', 'acme-plain');
      expect(plain.allowed).toBe(false);
      expect(plain.message).toContain('[HUMAN_REQUIRED]');
      // The deferred action consumed no budget.
      const plainCharter = findActiveCharter(
        { kind: 'organization', tenant_slug: 'acme-plain' },
        now(),
        opts()
      )!;
      expect(loadCharterUsage(plainCharter, now(), opts()).spent_today).toBe(0);
      const sup = spend(10_000, 'm-2', 'acme-sup');
      expect(sup).toMatchObject({ allowed: true, status: 'not_required' });
      const supCharter = findActiveCharter(
        { kind: 'organization', tenant_slug: 'acme-sup' },
        now(),
        opts()
      )!;
      expect(loadCharterUsage(supCharter, now(), opts()).spent_today).toBe(10_000);
    } finally {
      vi.mocked(evaluateDecisionRights).mockReturnValue(null as never);
    }
  });

  it('a scope with no charter is untouched by the adapter (legacy gate)', () => {
    expect(
      charterInputForDecision(
        { tenantSlug: 'other-co', decisionType: 'operational_spend', amount: 1 },
        opts()
      )
    ).toBeUndefined();
  });
});
