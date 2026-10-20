import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import { humanActor } from '../actor.js';
import { acceptCharter, retireCharter } from '../governance/accountability-charter-registry.js';
import { assertDotAccountabilityCharter } from './dot-authority.js';
import type { DotCharter } from './dot-charter.js';

const root = path.join(
  pathResolver.rootDir(),
  'active/shared/tmp',
  `dot-authority-${randomUUID()}`
);
const now = new Date('2026-10-01T00:00:00Z');
const deps = { rootDir: root, now: () => now };
const dot: DotCharter = {
  kind: 'dot-charter',
  dot_id: 'tenant-intake',
  version: '1',
  title: 'Intake',
  purpose: 'Plan',
  status: 'active',
  scope: { tier: 'confidential', tenant_slug: 'acme' },
  goal: { statement: 'Plan' },
  attention: { triggers: [] },
  authority: { authority_role: 'organization_operator', accountability_charter_ref: 'chr-acme' },
  notification: { deliver_to: { surface: 'surface', channel: 'inbox' } },
  runtime: { heartbeat_id: 'dot-intake' },
};
const savedPersona = process.env.KYBERION_PERSONA;
const savedRole = process.env.MISSION_ROLE;
afterEach(() => {
  if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
  else process.env.KYBERION_PERSONA = savedPersona;
  if (savedRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = savedRole;
  safeRmSync(root, { recursive: true, force: true });
});
function accepted() {
  process.env.KYBERION_PERSONA = 'ecosystem_architect';
  process.env.MISSION_ROLE = 'mission_controller';
  return acceptCharter(
    {
      draft: {
        charter_id: 'chr-acme',
        scope: { kind: 'organization', tenant_slug: 'acme' },
        accountable: {
          actor: 'user:owner',
          authority_basis: { kind: 'officer', evidence_ref: 'registry' },
          expires_at: '2026-10-02T00:00:00Z',
          deputies: [],
        },
        envelope: {
          money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 },
          data_tier: { read: [], write: [] },
          external_effects: {},
          irreversible: 'named_actions_only',
          irreversible_named_actions: [],
        },
        appetite: {
          max_loss_per_incident: 0,
          reputational_class_max: 'A',
          blast_radius_max: { recipients: 0, systems: 0 },
          tripwires: [],
        },
      },
      acceptedBy: humanActor('owner'),
      statement: 'I accept accountability.',
      validation: { holder_role: 'owner' },
      now,
    },
    { rootDir: root }
  );
}
describe('Dot accountability authority references', () => {
  it('allows harmless intake without a ref but refuses an unresolved declared ref', () => {
    expect(() =>
      assertDotAccountabilityCharter(
        { ...dot, authority: { authority_role: 'organization_operator' } },
        deps
      )
    ).not.toThrow();
    expect(() => assertDotAccountabilityCharter(dot, deps)).toThrow('current accepted charter');
  });
  it('resolves exact current tenant acceptance and rejects another tenant/id and expiry', () => {
    accepted();
    expect(() => assertDotAccountabilityCharter(dot, deps)).not.toThrow();
    expect(() =>
      assertDotAccountabilityCharter(
        { ...dot, scope: { ...dot.scope, tenant_slug: 'other' } },
        deps
      )
    ).toThrow();
    expect(() =>
      assertDotAccountabilityCharter(
        { ...dot, authority: { ...dot.authority, accountability_charter_ref: 'chr-other' } },
        deps
      )
    ).toThrow();
    expect(() =>
      assertDotAccountabilityCharter(dot, { ...deps, now: () => new Date('2026-10-03') })
    ).toThrow();
  });
  it('revocation invalidates subsequent admission and execution checks', () => {
    const charter = accepted();
    retireCharter(charter, humanActor('owner'), 'revoked', { rootDir: root }, now);
    expect(() => assertDotAccountabilityCharter(dot, deps)).toThrow();
  });
});
