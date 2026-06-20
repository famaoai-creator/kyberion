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
    delete process.env.CODEX_CLI;
    delete process.env.KYBERION_LOCAL_LLM_URL;
    delete process.env.KYBERION_LOCAL_LLM_MODEL;
    delete process.env.KYBERION_LOCAL_LLM_KEY;
    delete process.env.KYBERION_OPENROUTER_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.KYBERION_OPENROUTER_MODEL;
    delete process.env.KYBERION_OPENROUTER_URL;
  });

  it('installs codex-cli adapters when requested explicitly', () => {
    const installed = installReasoningBackends({ mode: 'codex-cli', force: true });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('codex-cli');
    expect(getReasoningBackend().name).toBe('codex-cli');
    expect(getIntentExtractor().name).toBe('codex-cli');
    expect(getVoiceBridge().name).toBe('codex-cli-text');
  });

  it('installs agy-cli adapters when requested explicitly', () => {
    const installed = installReasoningBackends({ mode: 'agy-cli', force: true });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('agy-cli');
    expect(getReasoningBackend().name).toBe('agy-cli');
    expect(getIntentExtractor().name).toBe('agy-cli');
    expect(getVoiceBridge().name).toBe('agy-cli-text');
  });

  it('installs the local OpenAI-compatible backend when configured', () => {
    process.env.KYBERION_LOCAL_LLM_URL = 'http://127.0.0.1:11434/v1';
    process.env.KYBERION_LOCAL_LLM_MODEL = 'llama3.2';

    const installed = installReasoningBackends({ mode: 'local' });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('local');
    expect(getReasoningBackend().name).toBe('openai-compatible');
  });

  it('installs the OpenRouter backend when configured', () => {
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    process.env.KYBERION_OPENROUTER_MODEL = 'meta-llama/llama-3-70b-instruct';

    const installed = installReasoningBackends({ mode: 'openrouter' });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('openrouter');
    expect(getReasoningBackend().name).toBe('openrouter');
  });

  it('auto-selects OpenRouter when its API key is present', () => {
    process.env.OPENROUTER_API_KEY = 'or-test-key';
    const installed = installReasoningBackends({ refreshProviders: true });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('openrouter');
    expect(getReasoningBackend().name).toBe('openrouter');
  });

  it('auto-selects codex-cli when the Codex CLI is the advertised host context', () => {
    process.env.CODEX_CLI = '1';
    const installed = installReasoningBackends({ refreshProviders: true });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('codex-cli');
    expect(getReasoningBackend().name).toBe('codex-cli');
    expect(getIntentExtractor().name).toBe('codex-cli');
    expect(getVoiceBridge().name).toBe('codex-cli-text');
  }, 60000);

  it('normalizes gemini-api to the CLI-backed gemini mode', () => {
    expect(normalizeReasoningBackendMode('gemini-api')).toBe('gemini-cli');
    expect(normalizeReasoningBackendMode('claude-agent')).toBe('claude-agent');
  });
});
