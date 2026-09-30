import { describe, expect, it } from 'vitest';
import { parseAddMemberResponse, parseMembersResponse } from './settings-types';
import { ssoText, type SsoMessageKey } from './i18n';

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

describe('ssoText', () => {
  it('has non-empty en and ja text for every key', () => {
    const keys: SsoMessageKey[] = [
      'settings_member_sso_title',
      'settings_member_sso_help',
      'settings_member_sso_none',
      'settings_member_sso_issuer',
      'settings_member_sso_subject',
      'settings_member_sso_bind',
      'settings_member_sso_unbind',
    ];
    for (const key of keys) {
      expect(ssoText(key, 'en').length).toBeGreaterThan(0);
      expect(ssoText(key, 'ja').length).toBeGreaterThan(0);
    }
    expect(ssoText('settings_member_sso_bind', 'ja')).toBe('紐付ける');
    expect(ssoText('settings_member_sso_unbind', 'ja')).toBe('解除');
  });
});
