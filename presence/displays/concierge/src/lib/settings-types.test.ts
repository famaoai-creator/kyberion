import { describe, expect, it } from 'vitest';
import { parseAddMemberResponse, parseMembersResponse } from './settings-types';
import { frontDeskText } from './i18n';

const base = {
  member_id: 'alice',
  display_name: 'Alice',
  status: 'active',
  sign_in: 'token',
  memberships: [{ tenant_slug: 'acme', role: 'owner' }],
};

describe('parseMembersResponse external_identities', () => {
  it('carries bound identities (issuer + subject only)', () => {
    const parsed = parseMembersResponse({
      ok: true,
      members: [
        { ...base, external_identities: [{ issuer: 'https://idp.example', subject: 'sub-1' }] },
      ],
    });
    expect(parsed?.[0].external_identities).toEqual([
      { issuer: 'https://idp.example', subject: 'sub-1' },
    ]);
  });

  it('defaults to [] for older payloads without the field', () => {
    const parsed = parseMembersResponse({ ok: true, members: [base] });
    expect(parsed?.[0].external_identities).toEqual([]);
    expect(parseAddMemberResponse({ ok: true, member: base, token: null })?.member).toMatchObject({
      external_identities: [],
    });
  });

  it('rejects malformed identity entries', () => {
    expect(
      parseMembersResponse({
        ok: true,
        members: [{ ...base, external_identities: [{ issuer: 'x' }] }],
      })
    ).toBeUndefined();
    expect(
      parseMembersResponse({ ok: true, members: [{ ...base, external_identities: 'nope' }] })
    ).toBeUndefined();
  });
});

describe('SSO member strings (vocabulary catalog)', () => {
  it('render non-empty text in en and ja, and ja differs from en where translated', () => {
    const keys = [
      'settings_member_sso_help',
      'settings_member_sso_none',
      'settings_member_sso_issuer',
      'settings_member_sso_subject',
      'settings_member_sso_bind',
      'settings_member_sso_unbind',
    ] as const;
    for (const key of keys) {
      expect(frontDeskText(key, 'en').length).toBeGreaterThan(0);
      expect(frontDeskText(key, 'ja').length).toBeGreaterThan(0);
      expect(frontDeskText(key, 'ja')).not.toBe(key);
    }
    expect(frontDeskText('settings_member_sso_bind', 'ja')).not.toBe(
      frontDeskText('settings_member_sso_bind', 'en')
    );
  });
});
