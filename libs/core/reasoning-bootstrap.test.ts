import { afterEach, describe, expect, it } from 'vitest';
import { getIntentExtractor, resetIntentExtractor } from './intent-extractor.js';
import { getReasoningBackend, resetReasoningBackend } from './reasoning-backend.js';
import {
  getInstalledReasoningMode,
  installReasoningBackends,
  resetReasoningBootstrap,
} from './reasoning-bootstrap.js';
import { getVoiceBridge, resetVoiceBridge } from './voice-bridge.js';

describe('reasoning-bootstrap', () => {
  afterEach(() => {
    resetReasoningBootstrap();
    resetReasoningBackend();
    resetIntentExtractor();
    resetVoiceBridge();
  });

  it('installs codex-cli adapters when requested explicitly', () => {
    const installed = installReasoningBackends({ mode: 'codex-cli' });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('codex-cli');
    expect(getReasoningBackend().name).toBe('codex-cli');
    expect(getIntentExtractor().name).toBe('codex-cli');
    expect(getVoiceBridge().name).toBe('codex-cli-text');
  });
});
