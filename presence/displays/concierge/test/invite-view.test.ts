import { describe, expect, it } from 'vitest';
import {
  codeFromSearch,
  inviteDisplayStatus,
  inviteErrorKind,
  inviteJoinPath,
  parseInviteOverview,
} from '../src/lib/invite-view';

describe('invite-view', () => {
  it('builds and reads the join link (the code survives URL encoding)', () => {
    const code = 'acme~inv-0123456789abcdef~AbC_-123';
    const path = inviteJoinPath(code);
    expect(path.startsWith('/join?code=')).toBe(true);
    expect(codeFromSearch(path.slice(path.indexOf('?')))).toBe(code);
    expect(codeFromSearch('')).toBe('');
    expect(codeFromSearch('?other=1')).toBe('');
  });
  it('maps server errors to a message kind', () => {
    expect(inviteErrorKind('identity_required', 401)).toBe('sign_in');
    expect(inviteErrorKind('not_found')).toBe('not_found');
    expect(inviteErrorKind('expired')).toBe('expired');
    expect(inviteErrorKind('used')).toBe('used');
    expect(inviteErrorKind('revoked')).toBe('revoked');
    expect(inviteErrorKind('already_member')).toBe('already_member');
    expect(inviteErrorKind('member_unavailable')).toBe('forbidden');
    expect(inviteErrorKind('something else')).toBe('generic');
  });
  it('a pending invite past its expiry reads as expired', () => {
    expect(inviteDisplayStatus({ status: 'pending', expired: true })).toBe('expired');
    expect(inviteDisplayStatus({ status: 'pending', expired: false })).toBe('pending');
    expect(inviteDisplayStatus({ status: 'accepted', expired: true })).toBe('accepted');
  });
  it('parses the overview and rejects malformed input', () => {
    expect(parseInviteOverview({ ok: true, tenants: [] })).toEqual([]);
    expect(parseInviteOverview({ ok: false, tenants: [] })).toBeUndefined();
    expect(parseInviteOverview({ ok: true, tenants: [{ tenant_slug: 'a' }] })).toBeUndefined();
    expect(parseInviteOverview(null)).toBeUndefined();
  });
});
