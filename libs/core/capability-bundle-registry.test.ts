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

  it('resolves media and meeting intents to governed bundles', () => {
    expect(resolveCapabilityBundleForIntent('speak-with-my-voice')?.bundle_id).toBe(
      'voice-speech-governed'
    );
    expect(resolveCapabilityBundleForIntent('generate-narrated-video')?.bundle_id).toBe(
      'narrated-video-governed'
    );
    expect(resolveCapabilityBundleForIntent('generate-video')?.bundle_id).toBe(
      'video-generation-governed'
    );
    expect(resolveCapabilityBundleForIntent('transcribe-audio')?.bundle_id).toBe(
      'audio-transcription-governed'
    );
    expect(resolveCapabilityBundleForIntent('live-voice')?.bundle_id).toBe(
      'realtime-voice-governed'
    );
    expect(resolveCapabilityBundleForIntent('meeting-operations')?.bundle_id).toBe(
      'meeting-operations-governed'
    );
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
