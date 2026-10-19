import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { agentActor, humanActor } from '../actor.js';
import { safeRmSync } from '../secure-io.js';
import type { CharterAction } from './accountability-charter.js';
import {
  acceptCharter,
  decideUnderCharter,
  evaluateUnderCharter,
  loadCharterUsage,
  readCharterLedger,
  recordCharterConsumption,
} from './accountability-charter-registry.js';

const NOW = new Date('2026-10-03T09:00:00.000Z');
const AVAILABLE = { accountable_available: true, available_deputies: [] };

const action = (over: Partial<CharterAction> = {}): CharterAction => ({
  actor: agentActor('kyberion://agent/acme/worker', 'user:owner'),
  action_class: 'payment',
  amount: 60,
  currency: 'JPY',
  reversible: false,
  irreversible_action_name: 'operational_spend',
  estimated_loss: 60,
  ...over,
});

describe('charter spend consumption is atomic', () => {
  let root = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  const opts = () => ({ rootDir: root });
  const scopeOf = (tenant: string) => ({ kind: 'organization', tenant_slug: tenant }) as const;

  const accept = (tenant: string) =>
    acceptCharter(
      {
        draft: {
          charter_id: `chr-${tenant}-1`,
          scope: scopeOf(tenant),
          accountable: {
            actor: 'user:owner',
            authority_basis: { kind: 'officer', evidence_ref: 'registry-extract' },
            expires_at: '2026-12-31T00:00:00.000Z',
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
        statement: 'I am accountable.',
        acceptedBy: humanActor('owner'),
        validation: { holder_role: 'owner' },
        now: NOW,
      },
      opts()
    );

  beforeAll(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `charter-spend-${randomUUID()}`
    );
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    accept('race-co');
    accept('atomic-co');
  });

  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (root) safeRmSync(root, { recursive: true, force: true });
  });

  it('the unlocked pattern can overspend; recording it is what atomicity prevents', () => {
    const scope = scopeOf('race-co');
    // Two concurrent readers both see zero usage and both allow. Recording both
    // afterwards is exactly the race `decideUnderCharter` closes.
    const first = evaluateUnderCharter(scope, action(), AVAILABLE, opts(), NOW)!;
    const second = evaluateUnderCharter(scope, action(), AVAILABLE, opts(), NOW)!;
    expect(first.decision.decision).toBe('allow');
    expect(second.decision.decision).toBe('allow');
    recordCharterConsumption(first.charter, action(), first.decision, opts(), NOW, 'race-1');
    recordCharterConsumption(second.charter, action(), second.decision, opts(), NOW, 'race-2');

    expect(loadCharterUsage(first.charter, NOW, opts()).spent_today).toBe(120);
    expect(
      readCharterLedger(first.charter, opts()).filter((e) => e.kind === 'consumption')
    ).toHaveLength(2);
  });

  it('serializes read-check-append: the second 60 JPY decision is denied', () => {
    const scope = scopeOf('atomic-co');
    const charter = evaluateUnderCharter(scope, action(), AVAILABLE, opts(), NOW)!.charter;
    const first = decideUnderCharter(scope, action(), AVAILABLE, opts(), NOW)!;
    const second = decideUnderCharter(scope, action(), AVAILABLE, opts(), NOW)!;
    expect(first.decision).toBe('allow');
    expect(second.decision).toBe('deny');
    expect(second.reasons).toContain('money.per_day exceeded');
    expect(loadCharterUsage(charter, NOW, opts()).spent_today).toBe(60);
    // A denial never consumes: only the allowed decision reached the ledger.
    expect(readCharterLedger(charter, opts()).filter((e) => e.kind === 'consumption')).toHaveLength(
      1
    );
  });
});
