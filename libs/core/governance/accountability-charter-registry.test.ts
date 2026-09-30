import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { agentActor, humanActor } from '../actor.js';
import { safeRmSync } from '../secure-io.js';
import type { Charter } from './accountability-charter.js';
import {
  acceptCharter,
  clearTripwire,
  decideUnderCharter,
  findActiveCharter,
  listActiveCharters,
  listCharterIds,
  readCharterLedger,
  evaluateUnderCharter,
  recordCharterConsumption,
  recordCharterDenial,
  loadCharterUsage,
  readCharter,
  recordTripwire,
  type AcceptCharterInput,
} from './accountability-charter-registry.js';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const SCOPE = { kind: 'organization', tenant_slug: 'acme' } as const;
const HERE = { accountable_available: true, available_deputies: [] as string[] };
const NHI = 'kyberion://agent/acme/worker';

function draft(id = 'chr-acme-1'): AcceptCharterInput['draft'] {
  return {
    charter_id: id,
    scope: SCOPE,
    accountable: {
      actor: 'user:owner',
      authority_basis: { kind: 'officer', evidence_ref: 'registry-extract' },
      expires_at: '2026-12-31T00:00:00.000Z',
      deputies: ['user:carol'],
    },
    envelope: {
      money: { currency: 'JPY', per_action: 100_000, per_day: 200_000, per_month: 1_000_000 },
      data_tier: { read: ['confidential:acme'], write: ['confidential:acme'] },
      external_effects: { payment: 'allow', send_message_external: 'allow' },
      irreversible: 'forbid',
    },
    appetite: {
      max_loss_per_incident: 100_000,
      reputational_class_max: 'B',
      blast_radius_max: { recipients: 10, systems: 1 },
      tripwires: ['audit-chain-gap'],
    },
  };
}

describe('accountability-charter-registry', () => {
  let root = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  const opts = () => ({ rootDir: root });
  const accept = (id = 'chr-acme-1', by = humanActor('owner')) =>
    acceptCharter(
      {
        draft: draft(id),
        statement: 'I am accountable for actions taken under this charter.',
        acceptedBy: by,
        validation: { holder_role: 'owner' },
        now: NOW,
      },
      opts()
    );

  beforeAll(() => {
    root = path.join(pathResolver.rootDir(), 'active', 'shared', 'tmp', `charter-${randomUUID()}`);
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
  });
  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (root) safeRmSync(root, { recursive: true, force: true });
  });

  it('only the named accountable human can accept; agents and others cannot', () => {
    expect(() => accept('chr-acme-x', agentActor(NHI, 'user:owner'))).toThrow(/human actor/);
    expect(() => accept('chr-acme-x', humanActor('mallory'))).toThrow(/only the accountable human/);
    expect(listCharterIds(SCOPE, opts())).toEqual([]);
  });

  it('accepts, hashes the statement, persists, and refuses in-place edits', () => {
    const c = accept();
    expect(c.accountable.statement_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readCharter(SCOPE, 'chr-acme-1', opts())).toEqual(c);
    expect(() => accept()).toThrow(/already exists/);
  });

  it('refuses a charter that exceeds authority', () => {
    const bad = draft('chr-acme-bad');
    bad.accountable.authority_basis = { kind: 'self' };
    expect(() =>
      acceptCharter(
        {
          draft: bad,
          statement: 's',
          acceptedBy: humanActor('owner'),
          validation: { holder_role: 'owner' },
          now: NOW,
        },
        opts()
      )
    ).toThrow(/authority cannot be exceeded/);
  });

  it('finds the single active charter; none for an unknown scope', () => {
    expect(findActiveCharter(SCOPE, NOW, opts())?.charter_id).toBe('chr-acme-1');
    expect(
      findActiveCharter({ kind: 'organization', tenant_slug: 'other' }, NOW, opts())
    ).toBeNull();
  });

  it('decideUnderCharter: allows and records consumption, then enforces the daily budget from the ledger', () => {
    const action = (amount: number) => ({
      actor: agentActor(NHI, 'user:owner'),
      action_class: 'payment',
      amount,
      currency: 'JPY',
      reversible: true,
    });
    expect(decideUnderCharter(SCOPE, action(90_000), HERE, opts(), NOW)?.decision).toBe('allow');
    expect(decideUnderCharter(SCOPE, action(90_000), HERE, opts(), NOW)?.decision).toBe(
      'allow_notify'
    );
    const c = readCharter(SCOPE, 'chr-acme-1', opts()) as Charter;
    expect(loadCharterUsage(c, NOW, opts()).spent_today).toBe(180_000);
    const over = decideUnderCharter(SCOPE, action(30_000), HERE, opts(), NOW);
    expect(over?.decision).toBe('deny');
    expect(over?.amendment?.field).toBe('envelope.money.per_day');
    // A denied action consumes nothing.
    expect(loadCharterUsage(c, NOW, opts()).spent_today).toBe(180_000);
    // Next UTC day: daily budget resets, monthly keeps counting.
    const tomorrow = new Date('2026-10-02T09:00:00.000Z');
    const u = loadCharterUsage(c, tomorrow, opts());
    expect(u.spent_today).toBe(0);
    expect(u.spent_this_month).toBe(180_000);
  });

  it('a tripwire stops everything until the accountable human clears it', () => {
    const c = readCharter(SCOPE, 'chr-acme-1', opts()) as Charter;
    expect(() => recordTripwire(c, 'not-declared', undefined, opts(), NOW)).toThrow(
      /not a declared/
    );
    recordTripwire(c, 'audit-chain-gap', 'seq 41 missing', opts(), NOW);
    const act = {
      actor: agentActor(NHI, 'user:owner'),
      action_class: 'internal_work',
      reversible: true,
    };
    expect(decideUnderCharter(SCOPE, act, HERE, opts(), NOW)?.decision).toBe('stop');
    expect(() =>
      clearTripwire(c, 'audit-chain-gap', agentActor(NHI, 'user:owner'), opts(), NOW)
    ).toThrow(/human actor/);
    expect(() => clearTripwire(c, 'audit-chain-gap', humanActor('mallory'), opts(), NOW)).toThrow(
      /cannot clear/
    );
    clearTripwire(c, 'audit-chain-gap', humanActor('carol'), opts(), NOW);
    expect(decideUnderCharter(SCOPE, act, HERE, opts(), NOW)?.decision).toBe('allow');
  });
  it('consumption and denial are idempotent per correlation id (a retried gate call never double-counts)', () => {
    const c = readCharter(SCOPE, 'chr-acme-1', opts()) as Charter;
    const action = {
      actor: agentActor(NHI, 'user:owner'),
      action_class: 'payment',
      amount: 1000,
      currency: 'JPY',
      reversible: true,
    };
    const at = new Date('2026-10-01T10:00:00.000Z');
    const ev = evaluateUnderCharter(SCOPE, action, HERE, opts(), at);
    expect(ev?.decision.decision).toMatch(/allow/);
    const before = readCharterLedger(c, opts()).length;
    expect(recordCharterConsumption(c, action, ev!.decision, opts(), at, 'corr-x')).toBe(true);
    expect(recordCharterConsumption(c, action, ev!.decision, opts(), at, 'corr-x')).toBe(false);
    expect(readCharterLedger(c, opts()).length).toBe(before + 1);
    // Evaluating alone never records.
    evaluateUnderCharter(SCOPE, action, HERE, opts(), at);
    expect(readCharterLedger(c, opts()).length).toBe(before + 1);
    const big = { ...action, amount: 900_000 };
    const denial = evaluateUnderCharter(SCOPE, big, HERE, opts(), at)!;
    expect(denial.decision.decision).toBe('deny');
    expect(recordCharterDenial(c, big, denial.decision, opts(), at, 'corr-y')).toBe(true);
    expect(recordCharterDenial(c, big, denial.decision, opts(), at, 'corr-y')).toBe(false);
    // Recording an allow as a denial (or vice versa) is a no-op.
    expect(recordCharterDenial(c, action, ev!.decision, opts(), at, 'corr-z')).toBe(false);
  });

  it('listActiveCharters returns the charters in force (no tenants registered in the fixture → only person scope)', () => {
    expect(listActiveCharters(NOW, opts())).toEqual([]);
  });
});
