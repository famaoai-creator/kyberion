import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { humanActor } from '../actor.js';
import { safeRmSync } from '../secure-io.js';
import { acceptCharter } from './accountability-charter-registry.js';
import { charterInputForDecision } from './charter-call-site.js';

const NOW = new Date('2026-10-01T09:00:00.000Z');

describe('charterInputForDecision', () => {
  let root = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  const opts = () => ({ rootDir: root });

  beforeAll(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `charter-site-${randomUUID()}`
    );
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    acceptCharter(
      {
        draft: {
          charter_id: 'chr-acme-1',
          scope: { kind: 'organization', tenant_slug: 'acme' },
          accountable: {
            actor: 'user:owner',
            authority_basis: { kind: 'officer', evidence_ref: 'registry-extract' },
            expires_at: '2026-12-31T00:00:00.000Z',
            deputies: [],
          },
          envelope: {
            money: { currency: 'JPY', per_action: 100_000, per_day: 200_000, per_month: 1_000_000 },
            data_tier: { read: [], write: [] },
            external_effects: { payment: 'allow' },
            irreversible: 'named_actions_only',
            irreversible_named_actions: ['operational_spend'],
          },
          appetite: {
            max_loss_per_incident: 100_000,
            reputational_class_max: 'B',
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
  });
  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (root) safeRmSync(root, { recursive: true, force: true });
  });

  it('maps operational spend to a payment acting for the accountable human', () => {
    const c = charterInputForDecision(
      {
        tenantSlug: 'acme',
        agentId: 'mission_controller',
        decisionType: 'operational_spend',
        amount: 40_000,
      },
      opts(),
      NOW
    );
    expect(c?.scope).toEqual({ kind: 'organization', tenant_slug: 'acme' });
    expect(c?.action).toMatchObject({
      action_class: 'payment',
      amount: 40_000,
      currency: 'JPY',
      reversible: false,
      irreversible_action_name: 'operational_spend',
      estimated_loss: 40_000,
    });
    expect(c?.action.actor).toMatchObject({
      kind: 'agent',
      id: 'kyberion://agent/acme/mission-controller',
      on_behalf_of: 'user:owner',
    });
  });

  it('falls back to a generic worker when the agent id is not NHI-safe', () => {
    const c = charterInputForDecision(
      { tenantSlug: 'acme', agentId: '  ', decisionType: 'contract_signature' },
      opts(),
      NOW
    );
    expect(c?.action.actor.id).toBe('kyberion://agent/acme/pipeline-worker');
    expect(c?.action.action_class).toBe('sign_contract');
  });

  it('is undefined (legacy gate) with no tenant, no active charter, or an unmapped decision type', () => {
    expect(
      charterInputForDecision({ decisionType: 'operational_spend', amount: 1 }, opts(), NOW)
    ).toBeUndefined();
    expect(
      charterInputForDecision(
        { tenantSlug: 'other-co', decisionType: 'operational_spend', amount: 1 },
        opts(),
        NOW
      )
    ).toBeUndefined();
    // No envelope vocabulary for these: "the charter says nothing" must never mean "allowed".
    for (const decisionType of ['headcount_expansion', 'secret_mutation', 'anything-new']) {
      expect(
        charterInputForDecision({ tenantSlug: 'acme', decisionType, amount: 1 }, opts(), NOW)
      ).toBeUndefined();
    }
    // Expired charter: not in force.
    expect(
      charterInputForDecision(
        { tenantSlug: 'acme', decisionType: 'operational_spend', amount: 1 },
        opts(),
        new Date('2027-01-01T00:00:00.000Z')
      )
    ).toBeUndefined();
  });
});
