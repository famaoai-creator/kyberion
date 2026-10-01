import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { agentActor, humanActor } from '../actor.js';
import { safeRmSync } from '../secure-io.js';
import {
  evaluateUnderCharter,
  findActiveCharter,
  recordCharterConsumption,
  recordTripwire,
} from './accountability-charter-registry.js';
import {
  MANUAL_STOP_TRIPWIRE,
  acceptCharterFromForm,
  parseCharterForm,
  renderAcceptanceStatement,
  statementDigest,
  viewCharter,
  type CharterForm,
} from './charter-service.js';

const NOW = new Date('2026-10-01T09:00:00.000Z');
const raw = (over: Record<string, unknown> = {}) => ({
  tenant_slug: 'acme',
  per_action: 100_000,
  per_day: 200_000,
  per_month: 1_000_000,
  max_loss_per_incident: 100_000,
  allow_named_spend: true,
  supersedes_decision_rights: false,
  deputies: ['user:carol'],
  expires_in_days: 90,
  reputational_class_max: 'B',
  ...over,
});
const form = (over: Record<string, unknown> = {}): CharterForm => {
  const parsed = parseCharterForm(raw(over));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.form;
};

describe('parseCharterForm', () => {
  it('accepts a coherent form and normalizes deputies', () => {
    const p = parseCharterForm(raw({ deputies: ['user:carol', 'user:carol'] }));
    expect(p.ok && p.form.deputies).toEqual(['user:carol']);
  });
  it.each([
    [{ tenant_slug: 'public' }, /tenant_slug/],
    [{ per_action: 1.5 }, /whole number/],
    [{ per_action: '1000' }, /whole number/],
    [{ per_day: -1 }, /out of range/],
    [{ per_action: 300_000 }, /per_action <= per_day/],
    [{ max_loss_per_incident: 2_000_000 }, /cannot exceed/],
    [{ expires_in_days: 0 }, /expires_in_days/],
    [{ expires_in_days: 999 }, /expires_in_days/],
    [{ deputies: ['carol'] }, /user:<member_id>/],
    [{ deputies: Array(6).fill('user:carol') }, /at most/],
    [{ reputational_class_max: 'Z' }, /reputational/],
  ])('rejects %j', (over, message) => {
    const p = parseCharterForm(raw(over as Record<string, unknown>));
    expect(p.ok).toBe(false);
    expect(!p.ok && p.error).toMatch(message);
  });
  it('rejects non-objects', () => {
    for (const bad of [null, 'x', [], 3]) expect(parseCharterForm(bad).ok).toBe(false);
  });
});

describe('renderAcceptanceStatement', () => {
  const args = { accountableId: 'user:owner', displayName: 'Owner', now: NOW };
  it('is deterministic and states every number, the stop, and the authority caveat', () => {
    const a = renderAcceptanceStatement({ form: form(), ...args });
    expect(a).toBe(renderAcceptanceStatement({ form: form(), ...args }));
    for (const needle of [
      'JPY 100,000',
      'JPY 200,000',
      'JPY 1,000,000',
      'user:carol',
      '2026-12-30',
      '停止',
      '権限を超える委任は',
    ]) {
      expect(a).toContain(needle);
    }
  });
  it('changes with any material choice (so the digest binds what was shown)', () => {
    const base = statementDigest(renderAcceptanceStatement({ form: form(), ...args }));
    for (const over of [
      { per_action: 90_000 },
      { allow_named_spend: false },
      { allow_customer_outbound: true },
      { supersedes_decision_rights: true },
      { deputies: [] },
      { expires_in_days: 30 },
    ]) {
      expect(statementDigest(renderAcceptanceStatement({ form: form(over), ...args }))).not.toBe(
        base
      );
    }
  });
});

describe('acceptCharterFromForm + viewCharter', () => {
  let root = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  const opts = () => ({ rootDir: root });
  const owner = humanActor('owner');
  const digestFor = (f: CharterForm) =>
    statementDigest(
      renderAcceptanceStatement({
        form: f,
        accountableId: 'user:owner',
        displayName: 'Owner',
        now: NOW,
      })
    );
  const accept = (f: CharterForm, over: Record<string, unknown> = {}) =>
    acceptCharterFromForm(
      {
        form: f,
        acceptedBy: owner,
        displayName: 'Owner',
        holderRole: 'owner',
        statementSha256: digestFor(f),
        now: NOW,
        idNonce: 'a1b2',
        ...over,
      },
      opts()
    );

  beforeAll(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `charter-svc-${randomUUID()}`
    );
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

  it('refuses anyone but an owner, an agent, or a statement that differs from what was shown', () => {
    const f = form();
    expect(() => accept(f, { holderRole: 'approver' })).toThrow(/only an owner/);
    expect(() => accept(f, { holderRole: undefined })).toThrow(/only an owner/);
    expect(() =>
      accept(f, { acceptedBy: agentActor('kyberion://agent/acme/worker', 'user:owner') })
    ).toThrow(/only a human/);
    expect(() => accept(f, { statementSha256: digestFor(form({ per_action: 1 })) })).toThrow(
      /statement changed/
    );
    expect(
      findActiveCharter({ kind: 'organization', tenant_slug: 'acme' }, NOW, opts())
    ).toBeNull();
  });

  it('creates an in-force charter with a manual-stop tripwire, owner authority evidence and the signed digest', () => {
    const f = form();
    const c = accept(f);
    expect(c.charter_id).toBe('chr-acme-20261001-a1b2');
    expect(c.appetite.tripwires).toEqual([MANUAL_STOP_TRIPWIRE]);
    expect(c.accountable).toMatchObject({
      actor: 'user:owner',
      authority_basis: { kind: 'owner', evidence_ref: 'member-registry:owner:owner@acme' },
      deputies: ['user:carol'],
      statement_sha256: digestFor(f),
    });
    expect(c.envelope.irreversible_named_actions).toEqual(['operational_spend']);
    expect(
      findActiveCharter({ kind: 'organization', tenant_slug: 'acme' }, NOW, opts())?.charter_id
    ).toBe(c.charter_id);
  });

  it('amending needs `replaces` and retires the old charter', () => {
    const f = form({ per_action: 50_000 });
    expect(() => accept(f, { idNonce: 'c3d4' })).toThrow(/pass replaces/);
    const c = accept(f, { idNonce: 'c3d4', replaces: 'chr-acme-20261001-a1b2' });
    expect(
      findActiveCharter({ kind: 'organization', tenant_slug: 'acme' }, NOW, opts())?.charter_id
    ).toBe(c.charter_id);
  });

  it('customer outbound is delegated only when the owner ticks it: it allows the effect and names the action', () => {
    const base = findActiveCharter({ kind: 'organization', tenant_slug: 'acme' }, NOW, opts())!;
    expect(base.envelope.external_effects.send_message_external).toBeUndefined();
    expect(viewCharter(base, NOW, opts(), 'en').allows_customer_outbound).toBe(false);
    const f = form({ per_action: 50_000, allow_customer_outbound: true });
    const c = accept(f, { idNonce: 'e5f6', replaces: base.charter_id });
    expect(c.envelope.external_effects.send_message_external).toBe('allow');
    expect(c.envelope.irreversible).toBe('named_actions_only');
    expect(c.envelope.irreversible_named_actions).toEqual([
      'operational_spend',
      'customer_outbound',
    ]);
    expect(viewCharter(c, NOW, opts(), 'en').allows_customer_outbound).toBe(true);
    const sent = evaluateUnderCharter(
      { kind: 'organization', tenant_slug: 'acme' },
      {
        actor: agentActor('kyberion://agent/acme/customer-conversation', 'user:owner'),
        action_class: 'send_message_external',
        reversible: false,
        irreversible_action_name: 'customer_outbound',
        estimated_loss: 0,
        reputational_class: 'B',
        blast_radius: { recipients: 1 },
      },
      { accountable_available: true, available_deputies: [] },
      opts(),
      NOW
    );
    expect(sent?.decision.decision).toBe('allow');
  });

  it('viewCharter: limits, usage, standing stops and the report text', () => {
    const c = findActiveCharter({ kind: 'organization', tenant_slug: 'acme' }, NOW, opts())!;
    const action = {
      actor: agentActor('kyberion://agent/acme/worker', 'user:owner'),
      action_class: 'payment',
      amount: 30_000,
      reversible: false,
      irreversible_action_name: 'operational_spend',
    };
    recordCharterConsumption(
      c,
      action,
      {
        decision: 'allow',
        reasons: [],
        consumption: { money: 30_000, loss: 30_000 },
        responsible: 'user:owner',
        charter_id: c.charter_id,
      },
      opts(),
      NOW,
      'k1'
    );
    recordTripwire(c, MANUAL_STOP_TRIPWIRE, 'stopped from the surface', opts(), NOW);
    const v = viewCharter(c, NOW, opts(), 'en');
    expect(v).toMatchObject({
      tenant_slug: 'acme',
      responsible: 'user:owner',
      allows_named_spend: true,
      supersedes_decision_rights: false,
      money: { per_action: 50_000 },
    });
    expect(v.report.money.spent_today).toBe(30_000);
    expect(v.report.tripwires_standing).toEqual([MANUAL_STOP_TRIPWIRE]);
    expect(v.report_text).toContain(MANUAL_STOP_TRIPWIRE);
  });
});
