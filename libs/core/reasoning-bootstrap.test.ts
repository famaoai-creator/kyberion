import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getIntentExtractor, resetIntentExtractor } from './intent-extractor.js';
import { getReasoningBackend, resetReasoningBackend } from './reasoning-backend.js';
import {
  consultCapabilityBrokerForMode,
  getInstalledReasoningMode,
  installReasoningBackends,
  normalizeReasoningBackendMode,
  resetReasoningBootstrap,
} from './reasoning-bootstrap.js';
import { getVoiceBridge, resetVoiceBridge } from './voice-bridge.js';

describe('reasoning-bootstrap', () => {
  // Isolate resolution from the harness host env: when this suite runs *inside* a
  // Claude Code session, the ambient CLAUDECODE would otherwise trigger the
  // claude-agent host-detection rule and pollute provider-fallback assertions.
  let savedClaudeCode: string | undefined;
  beforeEach(() => {
    savedClaudeCode = process.env.CLAUDECODE;
    delete process.env.CLAUDECODE;
  });

  afterEach(() => {
    if (savedClaudeCode === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = savedClaudeCode;
    resetReasoningBootstrap();
    resetReasoningBackend();
    resetIntentExtractor();
    resetVoiceBridge();
    delete process.env.CODEX_CLI;
    delete process.env.KYBERION_LOCAL_LLM_URL;
    delete process.env.KYBERION_LOCAL_LLM_MODEL;
    delete process.env.KYBERION_LOCAL_LLM_KEY;
    delete process.env.KYBERION_NEMOTRON_URL;
    delete process.env.KYBERION_NEMOTRON_MODEL;
    delete process.env.KYBERION_NEMOTRON_KEY;
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

  it('installs the Nemotron OpenAI-compatible backend when configured', () => {
    process.env.KYBERION_NEMOTRON_URL = 'https://integrate.api.nvidia.com/v1';
    process.env.KYBERION_NEMOTRON_MODEL = 'nemotron';

    const installed = installReasoningBackends({ mode: 'nemotron-api' });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('nemotron-api');
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

  it('auto-selects Nemotron before the generic local LLM when its URL is present', () => {
    process.env.KYBERION_NEMOTRON_URL = 'https://integrate.api.nvidia.com/v1';
    const installed = installReasoningBackends({ refreshProviders: true });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('nemotron-api');
    expect(getReasoningBackend().name).toBe('openai-compatible');
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
    expect(normalizeReasoningBackendMode('nemotron')).toBe('nemotron-api');
  });
});

describe('consultCapabilityBrokerForMode (GAP2: broker wired into reasoning selection)', () => {
  it('skips the broker entirely in stub/offline mode', () => {
    expect(consultCapabilityBrokerForMode('stub')).toBe('stub');
  });

  it('never overrides the resolved mode without a pin (safety: no behavior change)', () => {
    delete process.env.MISSION_ID; // clean pin scope → no reasoning-backend pin
    // With no pin, the broker either resolves fresh-but-unpinned or fails; both
    // paths must return the original mode unchanged.
    expect(consultCapabilityBrokerForMode('claude-cli')).toBe('claude-cli');
  });
});
