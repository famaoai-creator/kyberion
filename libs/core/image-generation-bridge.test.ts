import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  AdaptivePolicyRouter,
  ComfyUiImageGenerationProvider,
  CodexHostBridgeImageGenerationProvider,
  AgyHostBridgeImageGenerationProvider,
  GeminiServiceImageGenerationProvider,
  LocalFluxImageGenerationProvider,
  LlmApiImageGenerationProvider,
  HostAgentImageGenerationProvider,
} from './image-generation-bridge.js';
import { resolveLocalFluxGenerationPolicy } from './image-generation-policy.js';
import { ImageGenerationProvider } from './image-generation-types.js';

const mocks = vi.hoisted(() => {
  const executeServicePreset = vi.fn();
  const safeExecResult = vi.fn();
  const safeExistsSync = vi.fn();
  const safeMkdir = vi.fn();
  const probeToolRuntime = vi.fn();
  const probeServiceRuntime = vi.fn();
  return {
    executeServicePreset,
    safeExecResult,
    safeExistsSync,
    safeMkdir,
    probeToolRuntime,
    probeServiceRuntime,
  };
});

vi.mock('./service-engine.js', () => ({
  executeServicePreset: mocks.executeServicePreset,
}));

vi.mock('./tool-runtime-registry.js', () => ({
  probeToolRuntime: mocks.probeToolRuntime,
}));

vi.mock('./service-runtime-registry.js', () => ({
  probeServiceRuntime: mocks.probeServiceRuntime,
}));

vi.mock('./secure-io.js', async () => {
  const actual = (await vi.importActual('./secure-io.js')) as any;
  return {
    ...actual,
    safeWriteFile: vi.fn(),
    safeExecResult: mocks.safeExecResult,
    safeExistsSync: mocks.safeExistsSync,
    safeMkdir: mocks.safeMkdir,
  };
});

const globalFetch = global.fetch;

describe('AdaptivePolicyRouter', () => {
  let mockComfyUI: ImageGenerationProvider;
  let mockLocalDiffusion: ImageGenerationProvider;
  let mockLocalFlux: ImageGenerationProvider;
  let mockLlmApi: ImageGenerationProvider;
  let mockCodexHostBridge: ImageGenerationProvider;
  let mockAgyHostBridge: ImageGenerationProvider;
  let mockHostAgent: ImageGenerationProvider;

  beforeEach(() => {
    mockComfyUI = {
      id: 'comfyui',
      isAvailable: vi.fn().mockResolvedValue(true),
      generate: vi.fn(),
    };
    mockLocalDiffusion = {
      id: 'local_diffusion',
      isAvailable: vi.fn().mockResolvedValue(true),
      generate: vi.fn(),
    };
    mockLocalFlux = {
      id: 'local_flux',
      isAvailable: vi.fn().mockResolvedValue(true),
      generate: vi.fn(),
    };
    mockLlmApi = {
      id: 'llm_api',
      isAvailable: vi.fn().mockResolvedValue(true),
      generate: vi.fn(),
    };
    mockCodexHostBridge = {
      id: 'codex_host_bridge',
      isAvailable: vi.fn().mockResolvedValue(false),
      generate: vi.fn(),
    };
    mockAgyHostBridge = {
      id: 'agy_host_bridge',
      isAvailable: vi.fn().mockResolvedValue(false),
      generate: vi.fn(),
    };
    mockHostAgent = {
      id: 'host_agent',
      isAvailable: vi.fn().mockResolvedValue(false),
      generate: vi.fn(),
    };
  });

  it('selects the preferred provider if it is available', async () => {
    const router = new AdaptivePolicyRouter([
      mockComfyUI,
      mockLocalDiffusion,
      mockLocalFlux,
      mockLlmApi,
    ]);
    const provider = await router.selectProvider({
      prompt: 'a cat',
      providerPreference: ['llm_api'],
    });
    expect(provider.id).toBe('llm_api');
  });

  it('routes to local_flux by default in balanced mode', async () => {
    const router = new AdaptivePolicyRouter([
      mockComfyUI,
      mockLocalDiffusion,
      mockLocalFlux,
      mockLlmApi,
    ]);
    const provider = await router.selectProvider({
      prompt: 'a cat',
    });
    expect(provider.id).toBe('local_flux');
  });

  it('routes to local_flux first in privacy_first mode', async () => {
    const router = new AdaptivePolicyRouter([
      mockComfyUI,
      mockLocalDiffusion,
      mockLocalFlux,
      mockLlmApi,
    ]);
    const provider = await router.selectProvider({
      prompt: 'a cat',
      mode: 'privacy_first',
    });
    expect(provider.id).toBe('local_flux');
  });

  it('prefers the codex host bridge when it is available', async () => {
    (mockCodexHostBridge.isAvailable as any).mockResolvedValue(true);
    const router = new AdaptivePolicyRouter([
      mockComfyUI,
      mockLocalDiffusion,
      mockLocalFlux,
      mockLlmApi,
      mockCodexHostBridge,
      mockAgyHostBridge,
      mockHostAgent,
    ]);

    const provider = await router.selectProvider({
      prompt: 'a cat',
      mode: 'artistic',
    });

    expect(provider.id).toBe('codex_host_bridge');
  });
});

describe('ComfyUiImageGenerationProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.probeServiceRuntime.mockResolvedValue({
      available: true,
      reason: 'probe_succeeded',
    });
  });

  it('calls executeServicePreset with correct action and prompt', async () => {
    mocks.executeServicePreset.mockResolvedValue({
      prompt_id: 'mock-prompt-123',
    });

    const provider = new ComfyUiImageGenerationProvider();
    const result = await provider.generate({
      prompt: 'cyberpunk city',
      aspectRatio: '16:9',
      targetPath: 'output.png',
    });

    expect(result.status).toBe('submitted');
    expect(result.provider).toBe('comfyui');
    expect(result.promptId).toBe('mock-prompt-123');
    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'media-generation',
      'generate_image',
      expect.objectContaining({
        prompt: 'cyberpunk city',
        aspect_ratio: '16:9',
        target_path: 'output.png',
      })
    );
  });

  it('uses service runtime probe for availability', async () => {
    const provider = new ComfyUiImageGenerationProvider();
    await expect(provider.isAvailable()).resolves.toBe(true);
    expect(mocks.probeServiceRuntime).toHaveBeenCalledWith('comfyui', 'trial');
  });
});

describe('GeminiServiceImageGenerationProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('calls the gemini service preset and writes the returned image bytes', async () => {
    process.env.GEMINI_API_KEY = 'mock-gemini-key';
    mocks.executeServicePreset.mockResolvedValue({
      imageBytes: 'bW9jay1nZW1pbmktYnl0ZXM=',
    });

    const provider = new GeminiServiceImageGenerationProvider();
    const result = await provider.generate({
      prompt: 'a glowing fox in a glass city',
      aspectRatio: '16:9',
    });

    expect(result.status).toBe('succeeded');
    expect(result.provider).toBe('gemini_service');
    expect(mocks.executeServicePreset).toHaveBeenCalledWith(
      'gemini',
      'generate_image',
      expect.objectContaining({
        prompt: 'a glowing fox in a glass city',
        aspect_ratio: '16:9',
      }),
      'secret-guard'
    );
  });

  it('does not advertise Gemini service availability from GOOGLE_API_KEY alone', async () => {
    process.env.GOOGLE_API_KEY = 'mock-google-key';

    const provider = new GeminiServiceImageGenerationProvider();
    await expect(provider.isAvailable()).resolves.toBe(false);
  });
});

describe('LlmApiImageGenerationProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = globalFetch;
  });

  it('calls Gemini Imagen API when GEMINI_API_KEY is available', async () => {
    process.env.GEMINI_API_KEY = 'mock-imagen-key';
    const mockResponse = {
      generatedImages: [{ image: { imageBytes: 'bW9jay1ieXRlcw==' } }], // Base64 for 'mock-bytes'
    };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const provider = new LlmApiImageGenerationProvider();
    const result = await provider.generate({
      prompt: 'futuristic robot',
      aspectRatio: '16:9',
    });

    expect(result.status).toBe('succeeded');
    expect(result.provider).toBe('gemini_imagen');
    expect(result.path).toContain('generated-');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('imagen-3.0-generate-002:generateImages'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('16:9'),
      })
    );
  });

  it('calls OpenAI DALL-E API when OPENAI_API_KEY is available', async () => {
    process.env.OPENAI_API_KEY = 'mock-dalle-key';
    const mockResponse = {
      data: [{ b64_json: 'bW9jay1ieXRlcw==' }],
    };
    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });

    const provider = new LlmApiImageGenerationProvider();
    const result = await provider.generate({
      prompt: 'magical forest',
      aspectRatio: '16:9',
      providerPreference: ['openai'],
    });

    expect(result.status).toBe('succeeded');
    expect(result.provider).toBe('dalle_3');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/images/generations',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer mock-dalle-key',
        }),
        body: expect.stringContaining('1792x1024'), // DALL-E 16:9 mapping size
      })
    );
  });
});

describe('LocalFluxImageGenerationProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.safeExistsSync.mockReturnValue(true);
    mocks.safeExecResult.mockImplementation((command: string, args: string[]) => {
      if (command === 'which' && args[0] === 'uvx') {
        return { stdout: '/Users/famao/.local/bin/uvx\n', stderr: '', status: 0 };
      }
      if (command === 'which' && args[0] === 'uv') {
        return { stdout: '/opt/homebrew/bin/uv\n', stderr: '', status: 0 };
      }
      if (command === 'uvx') {
        return { stdout: '', stderr: '', status: 0 };
      }
      return { stdout: '', stderr: '', status: 1 };
    });
    mocks.probeToolRuntime.mockReturnValue({
      selected_action: 'run_trial',
      selected_backend: {
        kind: 'uvx',
        command: 'uvx',
        args: ['--from', 'mflux', 'mflux-generate'],
      },
      trial_backend: {
        kind: 'uvx',
        command: 'uvx',
        args: ['--from', 'mflux', 'mflux-generate'],
      },
      install_backend: null,
      installed_backend: null,
      installed: false,
      requires_install: false,
      managed_env_path: '/tmp/tool-runtime/mflux',
      state_path: '/tmp/tool-runtime/mflux/state.json',
      available_commands: ['uvx'],
      reason: 'mocked tool runtime',
    });
  });

  it('invokes mflux via uvx and writes to the requested target path', async () => {
    const provider = new LocalFluxImageGenerationProvider();
    const result = await provider.generate({
      prompt: 'a ceramic fox on a desk',
      aspectRatio: '16:9',
      targetPath: 'active/shared/exports/local-flux.png',
    });

    expect(result.status).toBe('succeeded');
    expect(result.provider).toBe('local_flux');
    expect(result.path).toBe('active/shared/exports/local-flux.png');
    expect(mocks.safeExecResult).toHaveBeenCalledWith(
      'uvx',
      expect.arrayContaining([
        '--from',
        'mflux',
        'mflux-generate',
        '--model',
        'schnell',
        '--prompt',
        'a ceramic fox on a desk',
        '--width',
        '1344',
        '--height',
        '768',
        '--output',
        'active/shared/exports/local-flux.png',
      ]),
      expect.objectContaining({
        timeoutMs: expect.any(Number),
        maxOutputMB: 50,
      })
    );
  });
});

describe('AdaptivePolicyRouter with Gemini service', () => {
  it('can resolve gemini_service when explicitly preferred', async () => {
    const router = new AdaptivePolicyRouter([
      {
        id: 'gemini_service',
        isAvailable: vi.fn().mockResolvedValue(true),
        generate: vi.fn(),
      },
      {
        id: 'comfyui',
        isAvailable: vi.fn().mockResolvedValue(true),
        generate: vi.fn(),
      },
      {
        id: 'local_flux',
        isAvailable: vi.fn().mockResolvedValue(true),
        generate: vi.fn(),
      },
      {
        id: 'llm_api',
        isAvailable: vi.fn().mockResolvedValue(true),
        generate: vi.fn(),
      },
    ]);

    const provider = await router.selectProvider({
      prompt: 'a cat',
      providerPreference: ['gemini_service'],
    });

    expect(provider.id).toBe('gemini_service');
  });
});

describe('resolveLocalFluxGenerationPolicy', () => {
  it('uses environment overrides for mflux settings', () => {
    const policy = resolveLocalFluxGenerationPolicy({
      KYBERION_MFLUX_PACKAGE: 'mflux',
      KYBERION_MFLUX_MODEL: 'dev',
      KYBERION_MFLUX_STEPS: '28',
      KYBERION_MFLUX_QUANTIZE: '4',
      KYBERION_MFLUX_TIMEOUT_MS: '120000',
    } as NodeJS.ProcessEnv);

    expect(policy).toEqual({
      packageSpec: 'mflux',
      model: 'dev',
      steps: 28,
      quantize: 4,
      timeoutMs: 120000,
    });
  });
});

describe('HostAgentImageGenerationProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reports unavailable by default when KYBERION_HOST_AGENT_ACTIVE is not set', async () => {
    const provider = new HostAgentImageGenerationProvider();
    await expect(provider.isAvailable()).resolves.toBe(false);
  });

  it('reports available when KYBERION_HOST_AGENT_ACTIVE is true', async () => {
    process.env.KYBERION_HOST_AGENT_ACTIVE = 'true';
    const provider = new HostAgentImageGenerationProvider();
    await expect(provider.isAvailable()).resolves.toBe(true);
  });

  it('skips generation if file already exists at targetPath', async () => {
    process.env.KYBERION_HOST_AGENT_ACTIVE = 'true';
    mocks.safeExistsSync.mockReturnValue(true);

    const provider = new HostAgentImageGenerationProvider();
    const result = await provider.generate({
      prompt: 'test prompt',
      targetPath: 'already-exists.png',
    });

    expect(result.status).toBe('succeeded');
    expect(result.provider).toBe('host_agent');
    expect(result.path).toBe('already-exists.png');
  });

  it('writes request metadata and throws exception if file does not exist', async () => {
    process.env.KYBERION_HOST_AGENT_ACTIVE = 'true';
    mocks.safeExistsSync.mockReturnValue(false);

    const provider = new HostAgentImageGenerationProvider();
    await expect(
      provider.generate({
        prompt: 'test prompt',
        targetPath: 'needs-gen.png',
      })
    ).rejects.toThrow('HOST_AGENT_IMAGE_GENERATION_REQUIRED');
  });
});

describe('CodexHostBridgeImageGenerationProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reports available in a codex CLI environment', async () => {
    process.env.CODEX_CLI = '1';
    const provider = new CodexHostBridgeImageGenerationProvider();
    await expect(provider.isAvailable()).resolves.toBe(true);
  });

  it('throws a host bridge required error when no request output exists', async () => {
    process.env.CODEX_VERSION = '1.0.0';
    mocks.safeExistsSync.mockReturnValue(false);

    const provider = new CodexHostBridgeImageGenerationProvider();
    await expect(
      provider.generate({
        prompt: 'test prompt',
        targetPath: 'needs-codex-gen.png',
      })
    ).rejects.toThrow('HOST_BRIDGE_IMAGE_GENERATION_REQUIRED');
  });
});

describe('AgyHostBridgeImageGenerationProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('reports available in an agy CLI environment', async () => {
    process.env.AGY_CLI = '1';
    const provider = new AgyHostBridgeImageGenerationProvider();
    await expect(provider.isAvailable()).resolves.toBe(true);
  });
});
