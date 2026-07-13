import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadMarketingRiskPolicy,
  pathResolver,
  safeMkdir,
  safeRmSync,
  safeWriteFile,
} from './index.js';

const roots: string[] = [];
const originalMissionRole = process.env.MISSION_ROLE;

function createCustomerPolicy(slug: string, allowedChannel: string): string {
  const root = pathResolver.rootResolve(`customer/${slug}`);
  const policyPath = path.join(root, 'policy', 'marketing-risk-policy.json');
  safeMkdir(path.dirname(policyPath), { recursive: true });
  roots.push(root);
  safeWriteFile(
    policyPath,
    JSON.stringify({
      version: '1.0.0',
      levels: {
        '0': { required_gates: ['G0', 'G1', 'G3'], required_reviewers: [], required_approvals: 0 },
      },
      allowed_channels: [allowedChannel],
      cta_domain_allowlist: [`${slug}.example.com`],
    })
  );
  return root;
}

beforeEach(() => {
  process.env.MISSION_ROLE = 'mission_controller';
});

afterEach(() => {
  for (const root of roots.splice(0)) safeRmSync(root, { recursive: true, force: true });
  if (originalMissionRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = originalMissionRole;
});

describe('marketing customer overlay', () => {
  it('applies isolated policies for customer A and B and preserves fallback', () => {
    const suffix = randomUUID().slice(0, 8);
    const customerA = `marketing-a-${suffix}`;
    const customerB = `marketing-b-${suffix}`;
    createCustomerPolicy(customerA, 'youtube-a');
    createCustomerPolicy(customerB, 'youtube-b');

    const policyA = loadMarketingRiskPolicy({ KYBERION_CUSTOMER: customerA });
    const policyB = loadMarketingRiskPolicy({ KYBERION_CUSTOMER: customerB });
    const fallback = loadMarketingRiskPolicy({});

    expect(policyA.allowed_channels).toEqual(['youtube-a']);
    expect(policyA.cta_domain_allowlist).toEqual([`${customerA}.example.com`]);
    expect(policyB.allowed_channels).toEqual(['youtube-b']);
    expect(policyB.cta_domain_allowlist).toEqual([`${customerB}.example.com`]);
    expect(policyA).not.toEqual(policyB);
    expect(fallback.allowed_channels).toContain('youtube');
    expect(fallback.allowed_channels).not.toContain('youtube-a');
    expect(fallback.allowed_channels).not.toContain('youtube-b');
  });
});
