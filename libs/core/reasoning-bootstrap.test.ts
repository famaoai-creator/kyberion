import { afterEach, describe, expect, it } from 'vitest';
import { getIntentExtractor, resetIntentExtractor } from './intent-extractor.js';
import { getReasoningBackend, resetReasoningBackend } from './reasoning-backend.js';
import {
  getInstalledReasoningMode,
  installReasoningBackends,
  normalizeReasoningBackendMode,
  resetReasoningBootstrap,
} from './reasoning-bootstrap.js';
import { getVoiceBridge, resetVoiceBridge } from './voice-bridge.js';

describe('reasoning-bootstrap', () => {
  afterEach(() => {
    resetReasoningBootstrap();
    resetReasoningBackend();
    resetIntentExtractor();
    resetVoiceBridge();
    delete process.env.KYBERION_LOCAL_LLM_URL;
    delete process.env.KYBERION_LOCAL_LLM_MODEL;
    delete process.env.KYBERION_LOCAL_LLM_KEY;
  });

  it('installs codex-cli adapters when requested explicitly', () => {
    const installed = installReasoningBackends({ mode: 'codex-cli' });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('codex-cli');
    expect(getReasoningBackend().name).toBe('codex-cli');
    expect(getIntentExtractor().name).toBe('codex-cli');
    expect(getVoiceBridge().name).toBe('codex-cli-text');
  });

  it('installs the local OpenAI-compatible backend when configured', () => {
    process.env.KYBERION_LOCAL_LLM_URL = 'http://127.0.0.1:11434/v1';
    process.env.KYBERION_LOCAL_LLM_MODEL = 'llama3.2';

    const installed = installReasoningBackends({ mode: 'local' });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('local');
    expect(getReasoningBackend().name).toBe('openai-compatible');
  });

  it('normalizes gemini-api to the CLI-backed gemini mode', () => {
    expect(normalizeReasoningBackendMode('gemini-api')).toBe('gemini-cli');
    expect(normalizeReasoningBackendMode('claude-agent')).toBe('claude-agent');
  });
});
