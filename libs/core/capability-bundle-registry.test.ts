import { describe, expect, it } from 'vitest';
import {
  loadCapabilityBundleRegistry,
  resolveCapabilityBundleForIntent,
  summarizeRelevantCapabilityBundlesForIntentIdsCompact,
  summarizeRelevantCapabilityBundlesForIntentIds,
} from './capability-bundle-registry.js';

describe('capability-bundle-registry', () => {
  it('loads the governed bundle registry', () => {
    const registry = loadCapabilityBundleRegistry();
    expect(registry.version).toBe('1.0.0');
    expect(registry.bundles.length).toBeGreaterThan(0);
  });

  it('resolves browser-facing intents to the governed browser bundle', () => {
    const bundle = resolveCapabilityBundleForIntent('open-site');
    expect(bundle?.bundle_id).toBe('browser-exploration-governed');
    expect(bundle?.harness_capability_refs).toContain('cli.native.browser_interactive');
  });

  it('summarizes relevant bundles for bundle-aware intent text', () => {
    const summary = summarizeRelevantCapabilityBundlesForIntentIds(['open-site']);
    expect(summary).toContain('browser-exploration-governed');
    expect(summary).toContain('cli.native.browser_interactive');
  });

  it('renders a compact summary first for bundle-aware intent ids', () => {
    const summary = summarizeRelevantCapabilityBundlesForIntentIdsCompact(['open-site']);
    expect(summary).toContain('browser-exploration-governed');
    expect(summary).toContain('kind=capability-bundle');
    expect(summary).toContain('harness=cli.native.browser_interactive');
  });
});
