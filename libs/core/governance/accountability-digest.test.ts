import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { humanActor } from '../actor.js';
import { safeRmSync } from '../secure-io.js';
import { acceptCharter } from './accountability-charter-registry.js';
import { runAccountabilityDigest } from './accountability-digest.js';

const NOW = new Date('2026-10-01T09:00:00.000Z');

describe('runAccountabilityDigest', () => {
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
      `charter-digest-${randomUUID()}`
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

  it('is empty while no charter is in force', () => {
    expect(runAccountabilityDigest({ now: NOW, options: opts() })).toEqual([]);
  });

  it('reports one entry per charter in force, never sending unless asked', () => {
    acceptCharter(
      {
        draft: {
          charter_id: 'chr-person-1',
          scope: { kind: 'person' },
          accountable: {
            actor: 'user:owner',
            authority_basis: { kind: 'self' },
            expires_at: '2026-12-31T00:00:00.000Z',
            deputies: [],
          },
          envelope: {
            money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 },
            data_tier: { read: [], write: [] },
            external_effects: {},
            irreversible: 'forbid',
          },
          appetite: {
            max_loss_per_incident: 0,
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
    const entries = runAccountabilityDigest({ now: NOW, locale: 'en', options: opts() });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sent: false });
    expect(entries[0].report.charter_id).toBe('chr-person-1');
    expect(entries[0].text.length).toBeGreaterThan(0);
  });
});
