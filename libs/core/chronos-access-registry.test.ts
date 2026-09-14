import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

import {
  findChronosTokenRegistration,
  parseChronosTokenRegistrations,
} from './chronos-access-registry.js';

describe('chronos-access-registry', () => {
  it('normalizes a valid registration and resolves a token by its digest', () => {
    const token = 'chronos-test-token';
    const digest = createHash('sha256').update(token).digest('hex');
    const [registration] = parseChronosTokenRegistrations({
      tokens: [
        {
          token_hash: digest,
          role: 'readonly',
          tenant_slugs: [' tenant-a '],
          organization_ids: [' org-a '],
          tier_access: ['public'],
          label: 'test',
        },
      ],
    });

    expect(registration).toMatchObject({
      token_hash: digest,
      role: 'readonly',
      tenant_slugs: ['tenant-a'],
      organization_ids: ['org-a'],
      tier_access: ['public'],
    });
    expect(findChronosTokenRegistration(token, [registration])).toEqual(registration);
  });

  it.each([
    { tokens: [{ token_hash: 'bad', role: 'readonly', tenant_slugs: ['tenant-a'] }] },
    { tokens: [{ token_hash: '0'.repeat(64), role: 'readonly', tenant_slugs: ['shared'] }] },
    {
      tokens: [
        {
          token_hash: '0'.repeat(64),
          role: 'readonly',
          tenant_slugs: ['tenant-a'],
          tier_access: [],
        },
      ],
    },
  ])('rejects malformed registry %#', (document) => {
    expect(() => parseChronosTokenRegistrations(document)).toThrow('invalid chronos access entry');
  });

  it('FD-07: accepts an optional member_id and round-trips it', () => {
    const digest = createHash('sha256').update('t').digest('hex');
    const [registration] = parseChronosTokenRegistrations({
      tokens: [
        { token_hash: digest, role: 'readonly', tenant_slugs: ['tenant-a'], member_id: 'alice' },
      ],
    });
    expect(registration.member_id).toBe('alice');
  });

  it('FD-07: rejects a malformed member_id', () => {
    const digest = createHash('sha256').update('t').digest('hex');
    expect(() =>
      parseChronosTokenRegistrations({
        tokens: [
          { token_hash: digest, role: 'readonly', tenant_slugs: ['tenant-a'], member_id: 'Alice!' },
        ],
      })
    ).toThrow('invalid chronos access entry');
  });
});

describe('issueChronosAccessToken', () => {
  it('appends a hashed registration to the connection document and returns the plaintext token once', async () => {
    vi.resetModules();
    const stored: { tokens?: unknown[] } = {};
    vi.doMock('./secret-guard.js', () => ({
      secretGuard: {
        loadConnectionDocument: vi.fn(() => stored),
        storeConnectionDocument: vi.fn((_id: string, patch: { tokens: unknown[] }) => {
          stored.tokens = patch.tokens;
          return { path: 'chronos-access.json', changedKeys: ['tokens'] };
        }),
      },
    }));

    const { issueChronosAccessToken } = await import('./chronos-access-registry.js');
    const issued = issueChronosAccessToken({
      role: 'readonly',
      tenantSlugs: ['acme-corp'],
      label: 'alice-token',
      memberId: 'alice',
    });

    expect(issued.token).toMatch(/^[0-9a-f]{64}$/);
    expect(issued.registration.member_id).toBe('alice');
    expect(issued.registration.label).toBe('alice-token');
    expect(stored.tokens).toHaveLength(1);
    expect((stored.tokens?.[0] as { token_hash: string }).token_hash).toBe(
      createHash('sha256').update(issued.token).digest('hex')
    );

    vi.doUnmock('./secret-guard.js');
  });
});
