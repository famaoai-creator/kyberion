import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import {
  clearCharterProposal,
  readPendingProposal,
  submitCharterProposal,
} from './charter-proposal.js';

const form = {
  tenant_slug: 'acme',
  per_action: 1000,
  per_day: 5000,
  per_month: 20000,
  max_loss_per_incident: 1000,
  expires_in_days: 30,
};

describe('charter proposals', () => {
  let rootDir = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  beforeAll(() => {
    rootDir = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `charter-proposal-${randomUUID()}`
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
    if (rootDir) safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('stores a validated draft and replaces it with a newer one', () => {
    const first = submitCharterProposal(
      { form, proposedBy: 'user:ap', proposedByName: 'Ap', note: ' hi ' },
      { rootDir }
    );
    expect(first.ok).toBe(true);
    const second = submitCharterProposal(
      { form: { ...form, per_day: 6000 }, proposedBy: 'user:ap', proposedByName: 'Ap' },
      { rootDir }
    );
    expect(second.ok).toBe(true);
    const pending = readPendingProposal('acme', { rootDir });
    expect(pending?.form.per_day).toBe(6000);
    expect(pending?.note).toBe('');
  });

  it('rejects an invalid form and never writes', () => {
    const bad = submitCharterProposal(
      {
        form: { ...form, tenant_slug: 'bad-one', per_action: 99999 },
        proposedBy: 'user:ap',
        proposedByName: 'Ap',
      },
      { rootDir }
    );
    expect(bad.ok).toBe(false);
    expect(readPendingProposal('bad-one', { rootDir })).toBeNull();
  });

  it('clears on dismiss/accept and reports whether one existed', () => {
    submitCharterProposal(
      { form: { ...form, tenant_slug: 'clear-me' }, proposedBy: 'user:ap', proposedByName: 'Ap' },
      { rootDir }
    );
    expect(clearCharterProposal('clear-me', 'dismissed', 'user:ow', { rootDir })).toBe(true);
    expect(clearCharterProposal('clear-me', 'dismissed', 'user:ow', { rootDir })).toBe(false);
    expect(readPendingProposal('clear-me', { rootDir })).toBeNull();
  });
});
