import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  assertCapabilityAllowed,
  checkCapabilityRestriction,
  loadCapabilityRestrictionPolicy,
} from './capability-restriction-policy.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

describe('capability restriction policy', () => {
  const rootDir = pathResolver.sharedTmp('capability-restriction-policy-tests');

  afterEach(() => {
    safeRmSync(rootDir, { recursive: true, force: true });
  });

  it('denies a restricted actuator name and allows an active name', () => {
    const policyDir = path.join(rootDir, 'knowledge/product/governance');
    safeMkdir(policyDir, { recursive: true });
    safeWriteFile(
      path.join(policyDir, 'restricted-capabilities.json'),
      JSON.stringify({
        version: '1.0',
        last_updated: '2026-08-30',
        restrictions: [
          {
            name: 'system-actuator',
            status: 'restricted',
            reason: 'operator pause',
            allow_override: true,
          },
          {
            name: 'file-actuator',
            status: 'active',
            reason: 'explicitly enabled',
            allow_override: false,
          },
        ],
      })
    );

    expect(checkCapabilityRestriction('system-actuator', rootDir)).toMatchObject({
      allowed: false,
      matched_name: 'system-actuator',
      reason: 'operator pause',
    });
    expect(checkCapabilityRestriction('file-actuator', rootDir)).toEqual({ allowed: true });
    expect(() => assertCapabilityAllowed('system-actuator', rootDir)).toThrow(
      '[CAPABILITY_RESTRICTED] system-actuator'
    );
  });

  it('fails closed when the policy is missing or schema-invalid', () => {
    expect(() => loadCapabilityRestrictionPolicy(rootDir)).toThrow(
      /Catalog restricted-capabilities is missing/
    );

    const policyDir = path.join(rootDir, 'knowledge/product/governance');
    safeMkdir(policyDir, { recursive: true });
    safeWriteFile(
      path.join(policyDir, 'restricted-capabilities.json'),
      JSON.stringify({ version: '1.0', restrictions: [{ name: 'system-actuator' }] })
    );

    expect(checkCapabilityRestriction('system-actuator', rootDir).allowed).toBe(false);
  });
});
