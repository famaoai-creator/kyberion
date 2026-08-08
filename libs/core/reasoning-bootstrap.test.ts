import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from './core.js';
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

const mockProviders = vi.hoisted(() => {
  const defaultProviders = [
    { provider: 'codex', installed: true, healthy: true },
    { provider: 'gemini', installed: false, healthy: false },
    { provider: 'agy', installed: false, healthy: false },
  ];

  let providers = defaultProviders;

  return {
    defaultProviders,
    setProviders: (nextProviders: typeof defaultProviders) => {
      providers = nextProviders;
    },
    discoverProviders: vi.fn(() => providers),
    resolveProviderDecision: vi.fn(() => {
      throw new Error('broker disabled in test');
    }),
  };
});

// XP-01: no snapshot by default so every pre-existing test in this file keeps
// exercising the exact pre-XP-01 candidate-construction behavior. Individual
// tests override the return value to exercise the narrowing path.
const mockCapabilityRegistry = vi.hoisted(() => ({
  peekProviderCapabilityRegistry: vi.fn(() => null as any),
  loadProviderCapabilityRegistry: vi.fn(() => [] as any),
}));

vi.mock('./provider-discovery.js', () => ({
  discoverProviders: mockProviders.discoverProviders,
}));

vi.mock('./capability-broker.js', () => ({
  resolveProviderDecision: mockProviders.resolveProviderDecision,
}));

vi.mock('./provider-capability-registry.js', () => ({
  peekProviderCapabilityRegistry: mockCapabilityRegistry.peekProviderCapabilityRegistry,
  loadProviderCapabilityRegistry: mockCapabilityRegistry.loadProviderCapabilityRegistry,
}));

describe('reasoning-bootstrap', () => {
  function expectCodexExcludedFallback(): void {
    const selectedMode = getInstalledReasoningMode();
    expect(selectedMode).not.toBe('codex-cli');
    expect(['claude-cli', 'grok-cli', 'agy-cli', 'copilot']).toContain(selectedMode);
  }

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
    delete process.env.KYBERION_HARNESS_SUBAGENT;
    delete process.env.KYBERION_LOCAL_LLM_URL;
    delete process.env.KYBERION_LOCAL_LLM_MODEL;
    delete process.env.KYBERION_LOCAL_LLM_KEY;
    delete process.env.KYBERION_OLLAMA_URL;
    delete process.env.OLLAMA_HOST;
    delete process.env.KYBERION_OLLAMA_MODEL;
    delete process.env.KYBERION_VLLM_URL;
    delete process.env.KYBERION_VLLM_MODEL;
    delete process.env.KYBERION_LMSTUDIO_URL;
    delete process.env.KYBERION_LM_STUDIO_URL;
    delete process.env.KYBERION_LMSTUDIO_MODEL;
    delete process.env.KYBERION_LLAMACPP_URL;
    delete process.env.KYBERION_LLAMACPP_MODEL;
    delete process.env.KYBERION_MLX_URL;
    delete process.env.KYBERION_MLX_MODEL;
    delete process.env.KYBERION_LOCALAI_URL;
    delete process.env.KYBERION_LOCALAI_MODEL;
    delete process.env.KYBERION_NEMOTRON_URL;
    delete process.env.KYBERION_NEMOTRON_MODEL;
    delete process.env.KYBERION_NEMOTRON_KEY;
    delete process.env.KYBERION_OPENROUTER_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.KYBERION_OPENROUTER_MODEL;
    delete process.env.KYBERION_OPENROUTER_PROFILE;
    delete process.env.KYBERION_OPENROUTER_COST_POLICY;
    delete process.env.KYBERION_OPENROUTER_REQUIRED_PARAMETERS;
    delete process.env.KYBERION_OPENROUTER_URL;
    mockProviders.setProviders(mockProviders.defaultProviders);
    mockCapabilityRegistry.peekProviderCapabilityRegistry.mockReset();
    mockCapabilityRegistry.peekProviderCapabilityRegistry.mockReturnValue(null);
    mockCapabilityRegistry.loadProviderCapabilityRegistry.mockReset();
    mockCapabilityRegistry.loadProviderCapabilityRegistry.mockReturnValue([]);
    delete process.env.KYBERION_PROVIDER_CAPABILITY_ROUTING;
  });

  it('installs codex-cli adapters when requested explicitly', () => {
    const installed = installReasoningBackends({ mode: 'codex-cli', force: true });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('codex-cli');
    expect(getReasoningBackend().name).toBe('codex-cli');
    expect(getIntentExtractor().name).toBe('codex-cli');
    expect(getVoiceBridge().name).toBe('codex-cli-text');
  });

  it('connects Codex to the provider-native harness dispatcher when opted in', () => {
    process.env.KYBERION_HARNESS_SUBAGENT = '1';

    const installed = installReasoningBackends({ mode: 'codex-cli', force: true });

    expect(installed).toBe(true);
    expect(getReasoningBackend().name).toBe('codex-cli+harness-subagent');
  });

  it('connects Claude Agent to the provider-neutral harness dispatcher when opted in', () => {
    process.env.KYBERION_HARNESS_SUBAGENT = '1';

    const installed = installReasoningBackends({ mode: 'claude-agent', force: true });

    expect(installed).toBe(true);
    expect(getReasoningBackend().name).toBe('claude-agent+harness-subagent');
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

  it('installs the Ollama backend when configured explicitly or via mode=ollama', () => {
    process.env.KYBERION_OLLAMA_URL = 'http://127.0.0.1:11434';
    process.env.KYBERION_OLLAMA_MODEL = 'qwen2.5-coder';

    const installed = installReasoningBackends({ mode: 'ollama' });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('ollama');
    expect(getReasoningBackend().name).toBe('openai-compatible');
  });

  it('installs the vLLM backend when configured explicitly or via mode=vllm', () => {
    process.env.KYBERION_VLLM_URL = 'http://127.0.0.1:8000/v1';

    const installed = installReasoningBackends({ mode: 'vllm' });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('vllm');
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
    process.env.KYBERION_OPENROUTER_COST_POLICY = 'paid-allowed';

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

  it('auto-selects OpenRouter when its namespaced API key is present', () => {
    process.env.KYBERION_OPENROUTER_KEY = 'or-test-key';
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

  it('auto-selects and installs codex-cli when codex is the only healthy CLI provider', () => {
    mockProviders.setProviders([
      { provider: 'codex', installed: true, healthy: true },
      { provider: 'gemini', installed: false, healthy: false },
      { provider: 'agy', installed: false, healthy: false },
    ]);

    const installed = installReasoningBackends({ refreshProviders: true });

    expect(installed).toBe(true);
    expect(getInstalledReasoningMode()).toBe('codex-cli');
    expect(getReasoningBackend().name).toBe('codex-cli');
    expect(getIntentExtractor().name).toBe('codex-cli');
    expect(getVoiceBridge().name).toBe('codex-cli-text');
  });

  it('keeps gemini-api as the direct Google AI Studio mode', () => {
    expect(normalizeReasoningBackendMode('gemini-api')).toBe('gemini-api');
    expect(normalizeReasoningBackendMode('claude-agent')).toBe('claude-agent');
    expect(normalizeReasoningBackendMode('nemotron')).toBe('nemotron-api');
  });

  describe('XP-01 provider-capability-registry wiring', () => {
    it('candidate construction is unchanged when no capability registry snapshot exists', () => {
      // Default afterEach state: peekProviderCapabilityRegistry() -> null.
      const installed = installReasoningBackends({ mode: 'codex-cli', force: true });

      expect(installed).toBe(true);
      expect(getInstalledReasoningMode()).toBe('codex-cli');
      expect(getReasoningBackend().name).toBe('codex-cli');
    });

    it('excludes an unauthenticated provider from the failover chain when a snapshot is present', () => {
      const infoSpy = vi.spyOn(logger, 'info');
      mockCapabilityRegistry.peekProviderCapabilityRegistry.mockReturnValue([
        {
          provider_id: 'codex',
          binary_found: true,
          authenticated: false,
          headless: true,
          structured_output: true,
          models: [],
          probed_at: '2026-07-25T00:00:00.000Z',
        },
        {
          provider_id: 'agy',
          binary_found: true,
          authenticated: true,
          headless: true,
          structured_output: true,
          models: [],
          probed_at: '2026-07-25T00:00:00.000Z',
        },
      ]);

      // The governed fallback order is host-dependent: Claude is preferred,
      // but CI may not have the local Claude binary and can legitimately use
      // the next installed CLI candidate.
      const installed = installReasoningBackends({ mode: 'codex-cli', force: true });

      expect(installed).toBe(true);
      expectCodexExcludedFallback();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('excluding candidate mode=codex-cli provider=codex')
      );
      infoSpy.mockRestore();
    });

    it('retains a provider when the authentication probe errored', () => {
      mockCapabilityRegistry.peekProviderCapabilityRegistry.mockReturnValue([
        {
          provider_id: 'codex',
          binary_found: true,
          authenticated: false,
          headless: true,
          structured_output: true,
          models: [],
          probed_at: '2026-07-25T00:00:00.000Z',
          probe_error: 'temporary auth status failure',
        },
        {
          provider_id: 'agy',
          binary_found: true,
          authenticated: 'unknown',
          headless: true,
          structured_output: true,
          models: [],
          probed_at: '2026-07-25T00:00:00.000Z',
        },
      ]);

      const installed = installReasoningBackends({ mode: 'codex-cli', force: true });

      expect(installed).toBe(true);
      expect(getInstalledReasoningMode()).toBe('codex-cli');
    });

    it('force-refreshes the capability registry when provider refresh is requested', () => {
      const installed = installReasoningBackends({
        mode: 'codex-cli',
        force: true,
        refreshProviders: true,
      });

      expect(installed).toBe(true);
      expect(mockCapabilityRegistry.loadProviderCapabilityRegistry).toHaveBeenCalledWith({
        forceRefresh: true,
      });
    });

    it('reselects the backend in a long-lived process when refresh is requested', () => {
      expect(installReasoningBackends({ mode: 'codex-cli', force: true })).toBe(true);
      expect(getInstalledReasoningMode()).toBe('codex-cli');

      expect(
        installReasoningBackends({ mode: 'agy-cli', force: true, refreshProviders: true })
      ).toBe(true);
      expect(getInstalledReasoningMode()).toBe('agy-cli');
    });

    it('excludes a provider whose binary was not found', () => {
      mockCapabilityRegistry.peekProviderCapabilityRegistry.mockReturnValue([
        {
          provider_id: 'codex',
          binary_found: false,
          authenticated: false,
          headless: true,
          structured_output: true,
          models: [],
          probed_at: '2026-07-25T00:00:00.000Z',
        },
        {
          provider_id: 'agy',
          binary_found: true,
          authenticated: 'unknown',
          headless: true,
          structured_output: true,
          models: [],
          probed_at: '2026-07-25T00:00:00.000Z',
        },
      ]);

      const installed = installReasoningBackends({ mode: 'codex-cli', force: true });

      expect(installed).toBe(true);
      expectCodexExcludedFallback();
    });

    it('the KYBERION_PROVIDER_CAPABILITY_ROUTING=0 kill-switch restores fail-open behavior', () => {
      process.env.KYBERION_PROVIDER_CAPABILITY_ROUTING = '0';
      mockCapabilityRegistry.peekProviderCapabilityRegistry.mockReturnValue([
        {
          provider_id: 'codex',
          binary_found: true,
          authenticated: false,
          headless: true,
          structured_output: true,
          models: [],
          probed_at: '2026-07-25T00:00:00.000Z',
        },
      ]);

      const installed = installReasoningBackends({ mode: 'codex-cli', force: true });

      expect(installed).toBe(true);
      expect(getInstalledReasoningMode()).toBe('codex-cli');
    });
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
