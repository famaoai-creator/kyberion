import { describe, expect, it } from 'vitest';
import { parseMemberCommand } from './organization_member.js';

describe('organization member command', () => {
  it('maps --slack to the Slack issuer', () => {
    expect(parseMemberCommand(['link-identity', 'alice', '--slack', 'U0123'])).toEqual({
      action: 'link-identity',
      memberId: 'alice',
      issuer: 'https://slack.com',
      subject: 'U0123',
    });
  });

  it('accepts a generic issuer and subject', () => {
    expect(
      parseMemberCommand([
        'unlink-identity',
        'alice',
        '--issuer',
        'https://accounts.google.com',
        '--subject',
        '42',
        '--email',
        'a@example.com',
      ])
    ).toMatchObject({
      action: 'unlink-identity',
      issuer: 'https://accounts.google.com',
      email: 'a@example.com',
    });
  });

  it('parses ensure-owner (provisions the local owner member the terminal approves as)', () => {
    expect(parseMemberCommand(['ensure-owner'])).toEqual({ action: 'ensure-owner' });
  });

  it('returns help and rejects incomplete input', () => {
    expect(parseMemberCommand([])).toBeNull();
    expect(() => parseMemberCommand(['rename', 'alice'])).toThrow(/unknown member command/);
    expect(() => parseMemberCommand(['link-identity'])).toThrow(/member id/);
    expect(() => parseMemberCommand(['link-identity', 'alice'])).toThrow(/--slack/);
    expect(() => parseMemberCommand(['link-identity', 'alice', '--slack'])).toThrow(
      /requires a value/
    );
  });
});
