import { describe, expect, it } from 'vitest';
import { safeReaddir, loadJson } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { loadRetryPolicy } from './async-utils.js';
import { loadRecoveryPolicy, buildGovernedRetryOptions } from './recovery-policy.js';

describe('canonical actuator retry profiles', () => {
  it('resolves every migrated manifest and retains explicit overrides', () => {
    const root = pathResolver.rootResolve('libs/actuators');
    const profiles = loadRetryPolicy().actuators!;
    let count = 0;
    for (const directory of safeReaddir(root)) {
      const manifestPath = pathResolver.rootResolve(
        'libs/actuators/' + directory + '/manifest.json'
      );
      let manifest: any;
      try {
        manifest = loadJson(manifestPath);
      } catch {
        continue;
      }
      const profileId = manifest.recovery_policy?.retry_profile;
      if (!profileId) continue;
      count += 1;
      const { retryable_categories, ...retry } = profiles[profileId];
      expect(manifest.recovery_policy.retry).toBeUndefined();
      const resolved = loadRecoveryPolicy(manifestPath);
      expect(resolved.retry).toEqual(retry);
      if (retryable_categories) expect(resolved.retryable_categories).toEqual(retryable_categories);
      const options = buildGovernedRetryOptions({
        manifestPath,
        defaults: {},
        override: { maxRetries: 9 },
      });
      expect(options.maxRetries).toBe(9);
      expect(options.initialDelayMs).toBe(retry.initialDelayMs);
    }
    expect(count).toBeGreaterThan(20);
  });
});
