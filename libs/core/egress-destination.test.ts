import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeWriteFile } from './secure-io.js';
import { classifyEgressDestination, _resetEgressPolicyCacheForTests } from './egress-policy.js';

const DIR = pathResolver.sharedTmp('egress-destination-tests');

beforeEach(() => {
  safeMkdir(DIR, { recursive: true });
  const policyPath = path.join(DIR, 'egress-policy.json');
  safeWriteFile(
    policyPath,
    JSON.stringify({
      version: '1',
      mode: 'enforce',
      manual_allowed_domains: ['public.example'],
      blocked_domains: ['evil.example'],
      tenant_allowed_domains: { 'tenant-a': ['review.tenant-a.example'] },
    })
  );
  process.env.KYBERION_EGRESS_POLICY_PATH = policyPath;
  _resetEgressPolicyCacheForTests();
});

afterEach(() => {
  delete process.env.KYBERION_EGRESS_POLICY_PATH;
  _resetEgressPolicyCacheForTests();
});

describe('classifyEgressDestination', () => {
  it('classifies a tenant-approved host as the personal audience for that tenant only', () => {
    expect(
      classifyEgressDestination('https://review.tenant-a.example/x', 'tenant-a').audience
    ).toBe('personal');
    expect(
      classifyEgressDestination('https://review.tenant-a.example/x', 'tenant-b').audience
    ).toBe('external');
    expect(classifyEgressDestination('https://review.tenant-a.example/x').audience).toBe(
      'external'
    );
  });

  it('classifies an allowlisted host as public and everything else as external', () => {
    expect(classifyEgressDestination('https://public.example/x', 'tenant-a').audience).toBe(
      'public'
    );
    expect(classifyEgressDestination('https://unlisted.example/x', 'tenant-a').audience).toBe(
      'external'
    );
    expect(classifyEgressDestination('https://evil.example/x', 'tenant-a').audience).toBe(
      'external'
    );
  });

  it('accepts a bare host and fails closed on unparsable input', () => {
    expect(classifyEgressDestination('public.example', 'tenant-a')).toEqual({
      hostname: 'public.example',
      audience: 'public',
    });
    expect(classifyEgressDestination('', 'tenant-a').audience).toBe('external');
    expect(classifyEgressDestination('http://', 'tenant-a').audience).toBe('external');
  });

  it('does not let a look-alike host inherit an approved domain', () => {
    expect(
      classifyEgressDestination('https://review.tenant-a.example.evil.test/x', 'tenant-a').audience
    ).toBe('external');
    expect(classifyEgressDestination('https://notpublic.example/x', 'tenant-a').audience).toBe(
      'external'
    );
  });
});
