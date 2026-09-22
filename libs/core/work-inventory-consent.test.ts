import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { recordMock } = vi.hoisted(() => ({ recordMock: vi.fn() }));
vi.mock('./audit-chain.js', () => ({ auditChain: { record: recordMock } }));

import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  evaluateConsentCoverage,
  findActiveConsent,
  grantWorkInventoryConsent,
  listWorkInventoryConsents,
  revokeWorkInventoryConsent,
  validateWorkInventoryConsent,
  workInventoryConsentPath,
  WorkInventoryConsentError,
  type GrantWorkInventoryConsentInput,
  type WorkInventoryObservationKind,
} from './work-inventory-consent.js';

const NOW = new Date('2026-09-22T08:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function grantInput(
  overrides: Partial<GrantWorkInventoryConsentInput> = {}
): GrantWorkInventoryConsentInput {
  return {
    member_id: 'alice',
    sources: ['desktop_recording'],
    observation_kinds: ['active_window'],
    purpose: 'Find repetitive work to automate',
    expires_at: new Date(NOW.getTime() + 30 * DAY).toISOString(),
    granted_by: { kind: 'human', id: 'alice' },
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkInventoryConsentError);
  expect((caught as WorkInventoryConsentError).code).toBe(code);
}

describe('work inventory consent', () => {
  let rootDir = '';

  beforeEach(() => {
    recordMock.mockReset();
    rootDir = path.join(pathResolver.rootDir(), 'active/shared/tmp', `wi-consent-${randomUUID()}`);
    safeMkdir(rootDir, { recursive: true });
  });

  afterEach(() => {
    if (rootDir && safeExistsSync(rootDir)) safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('grants a consent into the member personal tier, schema-valid and audited', () => {
    const consent = grantWorkInventoryConsent(grantInput({ tenant_slug: 'acme-corp' }), {
      now: NOW,
      rootDir,
    });
    const file = workInventoryConsentPath('alice', consent.consent_id, rootDir);
    expect(path.relative(rootDir, file)).toBe(
      path.join(
        'knowledge/personal/members/alice/work-inventory/consents',
        `${consent.consent_id}.json`
      )
    );
    expect(safeExistsSync(file)).toBe(true);
    expect(validateWorkInventoryConsent(consent)).toEqual({ valid: true, errors: [] });
    expect(listWorkInventoryConsents('alice', { rootDir })).toEqual([consent]);
    expect(recordMock).toHaveBeenCalledTimes(1);
    const event = recordMock.mock.calls[0][0];
    expect(event.action).toBe('work_inventory.consent_granted');
    expect(event.operation).toBe(consent.consent_id);
    expect(event.tenantSlug).toBe('acme-corp');
    expect(event.metadata.member_id).toBe('alice');
    // Free-text purpose never goes to the audit stream.
    expect(JSON.stringify(event)).not.toContain('Find repetitive work');
  });

  it('rejects a consent granted by someone other than the member', () => {
    expectCode(
      () =>
        grantWorkInventoryConsent(grantInput({ granted_by: { kind: 'human', id: 'bob' } }), {
          now: NOW,
          rootDir,
        }),
      'not_subject'
    );
    expect(recordMock).not.toHaveBeenCalled();
    expect(listWorkInventoryConsents('alice', { rootDir })).toEqual([]);
  });

  it.each(['clipboard', 'screen_frame'] as WorkInventoryObservationKind[])(
    'never allows the %s observation kind',
    (kind) => {
      expectCode(
        () =>
          grantWorkInventoryConsent(grantInput({ observation_kinds: ['active_window', kind] }), {
            now: NOW,
            rootDir,
          }),
        'forbidden_observation_kind'
      );
      expect(listWorkInventoryConsents('alice', { rootDir })).toEqual([]);
    }
  );

  it('rejects windows longer than 90 days and already-expired windows', () => {
    expectCode(
      () =>
        grantWorkInventoryConsent(
          grantInput({ expires_at: new Date(NOW.getTime() + 91 * DAY).toISOString() }),
          { now: NOW, rootDir }
        ),
      'invalid_input'
    );
    expectCode(
      () =>
        grantWorkInventoryConsent(
          grantInput({ expires_at: new Date(NOW.getTime() - DAY).toISOString() }),
          { now: NOW, rootDir }
        ),
      'invalid_input'
    );
    // Exactly 90 days is allowed.
    const ok = grantWorkInventoryConsent(
      grantInput({ expires_at: new Date(NOW.getTime() + 90 * DAY).toISOString() }),
      { now: NOW, rootDir }
    );
    expect(ok.expires_at).toBe(new Date(NOW.getTime() + 90 * DAY).toISOString());
  });

  it('rejects empty sources, unknown kinds, empty purpose and unsafe member ids', () => {
    expectCode(
      () => grantWorkInventoryConsent(grantInput({ sources: [] }), { now: NOW, rootDir }),
      'invalid_input'
    );
    expectCode(
      () => grantWorkInventoryConsent(grantInput({ observation_kinds: [] }), { now: NOW, rootDir }),
      'invalid_input'
    );
    expectCode(
      () => grantWorkInventoryConsent(grantInput({ purpose: '   ' }), { now: NOW, rootDir }),
      'invalid_input'
    );
    expectCode(
      () =>
        grantWorkInventoryConsent(
          grantInput({ member_id: '../bob', granted_by: { kind: 'human', id: '../bob' } }),
          { now: NOW, rootDir }
        ),
      'invalid_input'
    );
  });

  it('revokes only by the member themself, audited, once', () => {
    const consent = grantWorkInventoryConsent(grantInput(), { now: NOW, rootDir });
    recordMock.mockReset();
    expectCode(
      () =>
        revokeWorkInventoryConsent('alice', consent.consent_id, {
          by: { kind: 'human', id: 'bob' },
          now: NOW,
          rootDir,
        }),
      'not_subject'
    );
    expect(recordMock).not.toHaveBeenCalled();

    const revokedAt = new Date(NOW.getTime() + DAY);
    const revoked = revokeWorkInventoryConsent('alice', consent.consent_id, {
      by: { kind: 'human', id: 'alice' },
      now: revokedAt,
      rootDir,
    });
    expect(revoked.revoked_at).toBe(revokedAt.toISOString());
    expect(revoked.revoked_by).toEqual({ kind: 'human', id: 'alice' });
    expect(recordMock).toHaveBeenCalledTimes(1);
    expect(recordMock.mock.calls[0][0].action).toBe('work_inventory.consent_revoked');
    expect(listWorkInventoryConsents('alice', { rootDir })[0].revoked_at).toBe(
      revokedAt.toISOString()
    );
    expectCode(
      () =>
        revokeWorkInventoryConsent('alice', consent.consent_id, {
          by: { kind: 'human', id: 'alice' },
          rootDir,
        }),
      'invalid_state'
    );
  });

  it('findActiveConsent honours window, revocation, source and tenant binding', () => {
    const consent = grantWorkInventoryConsent(grantInput({ tenant_slug: 'acme-corp' }), {
      now: NOW,
      rootDir,
    });
    const inside = new Date(NOW.getTime() + DAY);
    const opts = { rootDir, tenant_slug: 'acme-corp' };
    expect(findActiveConsent('alice', 'desktop_recording', inside, opts)?.consent_id).toBe(
      consent.consent_id
    );
    expect(findActiveConsent('alice', 'browser_recording', inside, opts)).toBeNull();
    expect(
      findActiveConsent('alice', 'desktop_recording', inside, { rootDir, tenant_slug: 'other-co' })
    ).toBeNull();
    expect(findActiveConsent('alice', 'desktop_recording', inside, { rootDir })).toBeNull();
    expect(
      findActiveConsent('alice', 'desktop_recording', new Date(NOW.getTime() - 1), opts)
    ).toBeNull();
    expect(
      findActiveConsent('alice', 'desktop_recording', new Date(NOW.getTime() + 31 * DAY), opts)
    ).toBeNull();

    revokeWorkInventoryConsent('alice', consent.consent_id, {
      by: { kind: 'human', id: 'alice' },
      now: new Date(NOW.getTime() + 2 * DAY),
      rootDir,
    });
    // Still covered before revocation, not after.
    expect(findActiveConsent('alice', 'desktop_recording', inside, opts)).not.toBeNull();
    expect(
      findActiveConsent('alice', 'desktop_recording', new Date(NOW.getTime() + 3 * DAY), opts)
    ).toBeNull();
  });

  it('an unbound consent covers any tenant context', () => {
    grantWorkInventoryConsent(grantInput(), { now: NOW, rootDir });
    const inside = new Date(NOW.getTime() + DAY);
    expect(
      findActiveConsent('alice', 'desktop_recording', inside, { rootDir, tenant_slug: 'acme-corp' })
    ).not.toBeNull();
  });

  it('reports the most specific coverage failure', () => {
    const consent = grantWorkInventoryConsent(grantInput({ tenant_slug: 'acme-corp' }), {
      now: NOW,
      rootDir,
    });
    const t = (days: number) => new Date(NOW.getTime() + days * DAY);
    expect(evaluateConsentCoverage([], 'desktop_recording', [t(1)])).toMatchObject({
      code: 'no_consent',
    });
    expect(
      evaluateConsentCoverage([consent], 'browser_recording', [t(1)], 'acme-corp')
    ).toMatchObject({ code: 'source_not_covered' });
    expect(
      evaluateConsentCoverage([consent], 'desktop_recording', [t(1)], 'other-co')
    ).toMatchObject({ code: 'tenant_mismatch' });
    expect(
      evaluateConsentCoverage([consent], 'desktop_recording', [t(1), t(40)], 'acme-corp')
    ).toMatchObject({ code: 'consent_expired' });
    expect(
      evaluateConsentCoverage([consent], 'desktop_recording', [t(-1), t(1)], 'acme-corp')
    ).toMatchObject({ code: 'no_consent' });
    const revoked = { ...consent, revoked_at: t(2).toISOString(), revoked_by: consent.granted_by };
    expect(
      evaluateConsentCoverage([revoked], 'desktop_recording', [t(1), t(3)], 'acme-corp')
    ).toMatchObject({ code: 'consent_revoked' });
  });

  it('treats tampered stored consents as absent (fail closed)', () => {
    const consent = grantWorkInventoryConsent(grantInput(), { now: NOW, rootDir });
    const file = workInventoryConsentPath('alice', consent.consent_id, rootDir);
    const inside = new Date(NOW.getTime() + DAY);

    // Window stretched to a year by hand.
    safeWriteFile(
      file,
      JSON.stringify({ ...consent, expires_at: new Date(NOW.getTime() + 365 * DAY).toISOString() }),
      { encoding: 'utf8' }
    );
    expect(findActiveConsent('alice', 'desktop_recording', inside, { rootDir })).toBeNull();

    // clipboard smuggled in.
    safeWriteFile(file, JSON.stringify({ ...consent, observation_kinds: ['clipboard'] }), {
      encoding: 'utf8',
    });
    expect(listWorkInventoryConsents('alice', { rootDir })).toEqual([]);

    // Granted by someone else.
    safeWriteFile(file, JSON.stringify({ ...consent, granted_by: { kind: 'human', id: 'bob' } }), {
      encoding: 'utf8',
    });
    expect(listWorkInventoryConsents('alice', { rootDir })).toEqual([]);

    // Another member's consent copied into alice's directory.
    safeWriteFile(
      file,
      JSON.stringify({ ...consent, member_id: 'bob', granted_by: { kind: 'human', id: 'bob' } }),
      { encoding: 'utf8' }
    );
    expect(listWorkInventoryConsents('alice', { rootDir })).toEqual([]);
  });
});
