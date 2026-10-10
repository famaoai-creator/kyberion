import { describe, expect, it } from 'vitest';
import { parseScimTokenCommand, runOrganizationScimToken } from './organization_scim_token.js';

describe('organization scim-token command', () => {
  it('parses issue with defaults (issuing owner = owner)', () => {
    expect(parseScimTokenCommand(['issue', '--tenant', 'acme', '--label', 'Entra ID'])).toEqual({
      action: 'issue',
      tenant: 'acme',
      label: 'Entra ID',
      by: 'owner',
    });
  });

  it('parses issuer, default role and the issuing owner', () => {
    expect(
      parseScimTokenCommand([
        'issue',
        '--tenant',
        'acme',
        '--label',
        'Okta',
        '--issuer',
        'https://acme.okta.com',
        '--default-role',
        'operator',
        '--by',
        'alice',
      ])
    ).toEqual({
      action: 'issue',
      tenant: 'acme',
      label: 'Okta',
      issuer: 'https://acme.okta.com',
      defaultRole: 'operator',
      by: 'alice',
    });
  });

  it('parses list and revoke', () => {
    expect(parseScimTokenCommand(['list', '--tenant', 'acme'])).toEqual({
      action: 'list',
      tenant: 'acme',
    });
    expect(
      parseScimTokenCommand(['revoke', '--tenant', 'acme', '--id', 'scim-0123456789abcdef'])
    ).toEqual({ action: 'revoke', tenant: 'acme', tokenId: 'scim-0123456789abcdef', by: 'owner' });
  });

  it('returns help and rejects incomplete input', () => {
    expect(parseScimTokenCommand([])).toBeNull();
    expect(parseScimTokenCommand(['--help'])).toBeNull();
    expect(() => parseScimTokenCommand(['rotate'])).toThrow(/unknown scim-token command/);
    expect(() => parseScimTokenCommand(['issue', '--tenant', 'acme'])).toThrow(
      /--label is required/
    );
    expect(() => parseScimTokenCommand(['revoke', '--tenant', 'acme'])).toThrow(/--id is required/);
    expect(() => parseScimTokenCommand(['list', '--tenant'])).toThrow(/requires a value/);
  });

  it('refuses a chat-surface identity issuer before issuing anything', async () => {
    const printed: string[] = [];
    for (const issuer of ['https://slack.com', 'https://slack.com/', ' https://SLACK.com ']) {
      await expect(
        runOrganizationScimToken(
          ['issue', '--tenant', 'acme', '--label', 'IdP', '--issuer', issuer],
          (value) => printed.push(value)
        )
      ).rejects.toThrow(/chat-surface identity issuer .*pass --issuer/);
    }
    expect(printed).toEqual([]);
  });
});
