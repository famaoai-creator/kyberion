import { describe, expect, it } from 'vitest';
import { agentActor, humanActor } from '../actor.js';
import {
  envelopeExceeds,
  evaluateAgainstCharter,
  isCharterActive,
  validateCharter,
  type Charter,
  type CharterAction,
  type CharterUsage,
} from './accountability-charter.js';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const SHA = 'a'.repeat(64);
const NHI = 'kyberion://agent/acme/worker';

function charter(over: Partial<Charter> = {}): Charter {
  return {
    charter_id: 'chr-acme-1',
    scope: { kind: 'organization', tenant_slug: 'acme' },
    accountable: {
      actor: 'user:owner',
      authority_basis: { kind: 'officer', evidence_ref: 'registry-extract-2026' },
      accepted_at: '2026-09-30T00:00:00.000Z',
      expires_at: '2026-12-31T00:00:00.000Z',
      statement_sha256: SHA,
      deputies: ['user:carol'],
    },
    envelope: {
      money: { currency: 'JPY', per_action: 100_000, per_day: 500_000, per_month: 3_000_000 },
      data_tier: { read: ['public', 'confidential:acme'], write: ['confidential:acme'] },
      external_effects: {
        send_message_external: 'allow',
        publish_public: 'allow_with_review',
        payment: 'allow',
        sign_contract: 'forbid',
        credential_change: 'forbid',
      },
      irreversible: 'named_actions_only',
      irreversible_named_actions: ['send_invoice'],
    },
    appetite: {
      max_loss_per_incident: 300_000,
      reputational_class_max: 'B',
      blast_radius_max: { recipients: 50, systems: 1 },
      tripwires: ['audit-chain-gap'],
    },
    ...over,
  };
}

const USAGE: CharterUsage = { spent_today: 0, spent_this_month: 0, tripwires_hit: [] };
const HERE = { accountable_available: true, available_deputies: [] as string[] };

function act(over: Partial<CharterAction> = {}): CharterAction {
  return {
    actor: agentActor(NHI, 'user:owner'),
    action_class: 'internal_work',
    reversible: true,
    ...over,
  };
}
function run(
  action: CharterAction,
  o: { usage?: CharterUsage; availability?: typeof HERE; charter?: Charter } = {}
) {
  return evaluateAgainstCharter({
    charter: o.charter ?? charter(),
    action,
    usage: o.usage ?? USAGE,
    availability: o.availability ?? HERE,
    now: NOW,
  });
}

describe('validateCharter — authority cannot be exceeded', () => {
  const ctx = { holder_role: 'owner' as const, now: NOW };
  it('accepts a coherent charter', () => {
    expect(validateCharter(charter(), ctx)).toEqual([]);
  });
  it('rejects a viewer/operator as accountable', () => {
    expect(validateCharter(charter(), { ...ctx, holder_role: 'operator' })[0]).toMatch(
      /cannot be accountable/
    );
  });
  it('rejects payment/contract permission without an owner/officer basis with evidence', () => {
    const c = charter();
    c.accountable.authority_basis = { kind: 'self' };
    const v = validateCharter(c, ctx);
    expect(v.some((m) => m.includes('external_effects.payment'))).toBe(true);
  });
  it('rejects officer basis with no evidence_ref', () => {
    const c = charter();
    c.accountable.authority_basis = { kind: 'officer' };
    expect(validateCharter(c, ctx).some((m) => m.includes('evidence_ref'))).toBe(true);
  });
  it('rejects incoherent money limits and appetite above the monthly envelope', () => {
    const c = charter();
    c.envelope.money.per_action = 900_000;
    expect(validateCharter(c, ctx).some((m) => m.includes('per_action <= per_day'))).toBe(true);
    const d = charter();
    d.appetite.max_loss_per_incident = 9_000_000;
    expect(validateCharter(d, ctx).some((m) => m.includes('cannot exceed'))).toBe(true);
  });
  it('rejects expiry before acceptance and a deputy equal to the holder', () => {
    const c = charter();
    c.accountable.expires_at = '2026-09-01T00:00:00.000Z';
    c.accountable.deputies = ['user:owner'];
    const v = validateCharter(c, ctx);
    expect(v.some((m) => m.includes('expires_at must be after'))).toBe(true);
    expect(v.some((m) => m.includes('must differ'))).toBe(true);
  });
  it('a delegated charter must be a subset of its parent envelope', () => {
    const parent = charter().envelope;
    const child = charter();
    child.accountable.authority_basis = { kind: 'delegated', evidence_ref: 'parent-chr' };
    child.envelope.money.per_action = 200_000; // > parent 100_000
    child.envelope.external_effects.payment = 'forbid';
    child.envelope.money.per_action = 0;
    child.envelope.money.per_day = 0;
    child.envelope.money.per_month = 0;
    child.envelope.external_effects.send_message_external = 'allow';
    child.envelope.external_effects.publish_public = 'allow'; // parent allow_with_review
    const v = validateCharter(child, { ...ctx, parent_envelope: parent });
    expect(v.some((m) => m.includes('publish_public is more permissive'))).toBe(true);
    expect(validateCharter(child, ctx).some((m) => m.includes('requires the parent'))).toBe(true);
  });
  it('supersedes_decision_rights needs an owner/officer basis with evidence, and cannot be widened by delegation', () => {
    const c = charter();
    c.envelope.supersedes_decision_rights = true;
    expect(validateCharter(c, ctx)).toEqual([]);
    c.accountable.authority_basis = { kind: 'self' };
    // (payment is also permitted here, so both violations are reported)
    expect(validateCharter(c, ctx).some((m) => m.includes('supersedes_decision_rights'))).toBe(
      true
    );
    const parent = charter().envelope; // does not supersede
    const child = charter();
    child.accountable.authority_basis = { kind: 'delegated', evidence_ref: 'parent-chr' };
    child.envelope.supersedes_decision_rights = true;
    expect(
      envelopeExceeds(child.envelope, parent).some((m) => m.includes('supersedes_decision_rights'))
    ).toBe(true);
    expect(
      envelopeExceeds({ ...child.envelope, supersedes_decision_rights: false }, parent)
    ).toEqual([]);
  });

  it('envelopeExceeds is empty for an identical envelope', () => {
    expect(envelopeExceeds(charter().envelope, charter().envelope)).toEqual([]);
  });
});

describe('evaluateAgainstCharter', () => {
  it('allows an in-envelope reversible action without asking anyone', () => {
    const d = run(act());
    expect(d.decision).toBe('allow');
    expect(d.responsible).toBe('user:owner');
  });
  it('denies when the charter is expired or not yet accepted', () => {
    const c = charter();
    c.accountable.expires_at = '2026-10-01T00:00:00.000Z';
    expect(isCharterActive(c, NOW)).toBe(false);
    expect(run(act(), { charter: c }).reasons).toEqual(['charter_not_active']);
  });
  it('denies a human actor and an agent acting for someone else', () => {
    expect(run(act({ actor: humanActor('owner') })).decision).toBe('deny');
    expect(run(act({ actor: agentActor(NHI, 'user:mallory') })).reasons[0]).toMatch(
      /actor_not_delegated/
    );
    expect(run(act({ actor: agentActor(NHI) })).reasons[0]).toMatch(/actor_not_delegated/);
  });
  it('accepts an agent acting for a deputy', () => {
    expect(run(act({ actor: agentActor(NHI, 'user:carol') })).decision).toBe('allow');
  });
  it('stops on a tripwire, before anything else', () => {
    const d = run(act(), { usage: { ...USAGE, tripwires_hit: ['audit-chain-gap'] } });
    expect(d.decision).toBe('stop');
    expect(d.reasons).toEqual(['tripwire:audit-chain-gap']);
  });
  it('payments: allowed inside limits, records consumption', () => {
    const d = run(act({ action_class: 'payment', amount: 50_000, currency: 'JPY' }));
    expect(d.decision).toBe('allow');
    expect(d.consumption.money).toBe(50_000);
  });
  it('payments: over per-action denies with an amendment proposal, not an approval request', () => {
    const d = run(act({ action_class: 'payment', amount: 150_000, currency: 'JPY' }));
    expect(d.decision).toBe('deny');
    expect(d.amendment?.field).toBe('envelope.money.per_action');
  });
  it('payments: daily and monthly budgets accumulate from usage', () => {
    const day = run(act({ action_class: 'payment', amount: 60_000 }), {
      usage: { ...USAGE, spent_today: 450_000 },
    });
    expect(day.amendment?.field).toBe('envelope.money.per_day');
    const month = run(act({ action_class: 'payment', amount: 60_000 }), {
      usage: { ...USAGE, spent_this_month: 2_990_000 },
    });
    expect(month.amendment?.field).toBe('envelope.money.per_month');
  });
  it('notifies when a payment pushes a budget past 80%', () => {
    const d = run(act({ action_class: 'payment', amount: 50_000 }), {
      usage: { ...USAGE, spent_today: 360_000 },
    });
    expect(d.decision).toBe('allow_notify');
    expect(d.reasons).toContain('budget_near_limit');
  });
  it('rejects a foreign currency', () => {
    expect(run(act({ action_class: 'payment', amount: 1, currency: 'USD' })).reasons[0]).toMatch(
      /currency_mismatch/
    );
  });
  it('forbidden effect classes deny and propose widening; contract signing is forbidden', () => {
    const d = run(act({ action_class: 'sign_contract' }));
    expect(d.decision).toBe('deny');
    expect(d.amendment?.field).toBe('envelope.external_effects.sign_contract');
  });
  it('allow_with_review needs a passed cross-provider review', () => {
    expect(run(act({ action_class: 'publish_public' })).decision).toBe('deny');
    expect(
      run(act({ action_class: 'publish_public', reviewed_by_other_provider: true })).decision
    ).toBe('allow');
  });
  it('data scope must be delegated', () => {
    const ok = run(act({ data: { tier: 'confidential', tenant_slug: 'acme', mode: 'read' } }));
    expect(ok.decision).toBe('allow');
    const other = run(
      act({ data: { tier: 'confidential', tenant_slug: 'other-co', mode: 'read' } })
    );
    expect(other.decision).toBe('deny');
    const personal = run(act({ data: { tier: 'personal', mode: 'read' } }));
    expect(personal.decision).toBe('deny');
  });
  it('irreversible: only pre-named actions, and then prefers a reversible path', () => {
    const named = run(act({ reversible: false, irreversible_action_name: 'send_invoice' }));
    expect(named.decision).toBe('allow');
    expect(named.prefer_reversible).toBe(true);
    const unnamed = run(act({ reversible: false, irreversible_action_name: 'drop_table' }));
    expect(unnamed.decision).toBe('deny');
    const c = charter();
    c.envelope.irreversible = 'forbid';
    expect(run(act({ reversible: false }), { charter: c }).amendment?.field).toBe(
      'envelope.irreversible'
    );
  });
  it('appetite: loss, reputation and blast radius each deny', () => {
    expect(run(act({ estimated_loss: 400_000 })).amendment?.field).toBe(
      'appetite.max_loss_per_incident'
    );
    expect(run(act({ reputational_class: 'C' })).amendment?.field).toBe(
      'appetite.reputational_class_max'
    );
    expect(run(act({ blast_radius: { recipients: 51 } })).amendment?.field).toBe(
      'appetite.blast_radius_max'
    );
    expect(
      run(act({ reputational_class: 'B', blast_radius: { recipients: 50, systems: 1 } })).decision
    ).toBe('allow');
  });
  it('safe mode: nobody available → only reversible zero-cost internal work', () => {
    const away = { accountable_available: false, available_deputies: [] as string[] };
    expect(run(act(), { availability: away }).decision).toBe('allow');
    expect(run(act({ action_class: 'payment', amount: 1 }), { availability: away }).decision).toBe(
      'deny'
    );
    expect(
      run(act({ action_class: 'send_message_external' }), { availability: away }).decision
    ).toBe('deny');
    expect(run(act({ reversible: false }), { availability: away }).decision).toBe('deny');
    const deputy = { accountable_available: false, available_deputies: ['user:carol'] };
    expect(
      run(act({ action_class: 'send_message_external' }), { availability: deputy }).decision
    ).toBe('allow');
  });
  it('a vocabulary decision must be delegated by name; silence is never a grant', () => {
    const scheduling = act({ decision_type: 'meeting_scheduling' });
    const none = run(scheduling);
    expect(none.decision).toBe('deny');
    expect(none.amendment).toMatchObject({
      field: 'envelope.delegated_decisions.meeting_scheduling',
      current: 'forbid',
      requested: 'allow',
    });
    const c = charter();
    c.envelope.delegated_decisions = {
      meeting_scheduling: 'allow',
      external_reply: 'allow_with_review',
    };
    const evaluate = (action: CharterAction) =>
      evaluateAgainstCharter({ charter: c, action, usage: USAGE, availability: HERE, now: NOW });
    expect(evaluate(scheduling).decision).toBe('allow');
    expect(evaluate(act({ decision_type: 'external_reply' })).decision).toBe('deny');
    expect(
      evaluate(act({ decision_type: 'external_reply', reviewed_by_other_provider: true })).decision
    ).toBe('allow');
    // Delegating the type does not waive the other limits.
    expect(
      evaluate(act({ decision_type: 'meeting_scheduling', blast_radius: { recipients: 51 } }))
        .decision
    ).toBe('deny');
  });
});

describe('delegated decisions in a delegation chain', () => {
  it('a child cannot delegate a decision the parent does not', () => {
    const parent = charter().envelope;
    parent.delegated_decisions = { meeting_scheduling: 'allow_with_review' };
    const child = { ...parent, delegated_decisions: { meeting_scheduling: 'allow' as const } };
    expect(envelopeExceeds(child, parent)).toContain(
      'delegated_decisions.meeting_scheduling is more permissive than the parent envelope'
    );
    const extra = { ...parent, delegated_decisions: { external_reply: 'allow' as const } };
    expect(envelopeExceeds(extra, parent)).toContain(
      'delegated_decisions.external_reply is more permissive than the parent envelope'
    );
    expect(envelopeExceeds({ ...parent, delegated_decisions: {} }, parent)).toEqual([]);
  });

  it('an unknown policy value is refused by validation and grants nothing', () => {
    const c = charter();
    c.envelope.delegated_decisions = { meeting_scheduling: 'yes' as never };
    const ctx = { holder_role: 'owner' as const, now: NOW };
    expect(validateCharter(c, ctx).some((m) => m.includes('delegated_decisions.'))).toBe(true);
    const evaluate = (type: string) =>
      evaluateAgainstCharter({
        charter: c,
        action: act({ decision_type: type }),
        usage: USAGE,
        availability: HERE,
        now: NOW,
      }).decision;
    expect(evaluate('meeting_scheduling')).toBe('deny');
    expect(evaluate('constructor')).toBe('deny');
  });
});
