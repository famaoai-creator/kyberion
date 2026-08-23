import { describe, expect, it } from 'vitest';
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
});
