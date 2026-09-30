import { describe, expect, it } from 'vitest';
import { hasEnvironmentCapabilityProbe } from '@agent/core/environment-capability';
import './run_doctor.js';

describe('doctor environment capability probe registration', () => {
  it('registers the probes required by the doctor manifests', () => {
    expect(hasEnvironmentCapabilityProbe('node-version.floor')).toBe(true);
    expect(hasEnvironmentCapabilityProbe('repo-build.receipt')).toBe(true);
    expect(hasEnvironmentCapabilityProbe('reasoning-backend.any-real')).toBe(true);
  });
});
