import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  AdaptivePolicyRouter,
  WindowsNativeOcrProvider,
  TesseractOcrProvider,
  AppleVisionOcrProvider,
  LlmApiOcrProvider,
  LocalVlmOcrProvider,
  ocrImageWithRouter,
  parseClaudeOcrResponse,
  parseGeminiOcrResponse,
  parseLocalVlmOcrResponse,
  parseOpenAiOcrResponse,
} from './ocr-bridge.js';
import { OcrProvider } from './ocr-types.js';

const mocks = vi.hoisted(() => {
  const spawn = vi.fn();
  return { spawn };
});

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

const tesseractMocks = vi.hoisted(() => {
  const createWorker = vi.fn();
  return { createWorker };
});

const networkMocks = vi.hoisted(() => {
  const secureFetch = vi.fn();
  return { secureFetch };
});

vi.mock('tesseract.js', () => ({
  createWorker: tesseractMocks.createWorker,
}));

vi.mock('./network.js', () => ({
  secureFetch: networkMocks.secureFetch,
}));

// Mock secure-io dynamically so we don't hit the filesystem during test execution
vi.mock('./secure-io.js', async () => {
  const actual = (await vi.importActual('./secure-io.js')) as any;
  return {
    ...actual,
    safeReadFile: () => Buffer.from('dummy_png_bytes'),
  };
});

const globalFetch = global.fetch;

describe('AdaptivePolicyRouter', () => {
  let mockTesseract: OcrProvider;
  let mockAppleVision: OcrProvider;

  beforeEach(() => {
    mockTesseract = {
      id: 'tesseract',
      dataEgress: 'none' as const,
      isAvailable: vi.fn().mockResolvedValue(true),
      recognize: vi.fn(),
    };
    mockAppleVision = {
      id: 'apple_vision',
      dataEgress: 'none' as const,
      isAvailable: vi.fn().mockResolvedValue(true),
      recognize: vi.fn(),
    };
  });

  it('selects the preferred provider if it is available', async () => {
    const router = new AdaptivePolicyRouter([mockTesseract, mockAppleVision]);
    const provider = await router.selectProvider({
      path: 'test.png',
      providerPreference: ['apple_vision'],
    });
    expect(provider.id).toBe('apple_vision');
  });

  it('falls back to the next preferred provider if the first one is not available', async () => {
    mockAppleVision.isAvailable = vi.fn().mockResolvedValue(false);
    const router = new AdaptivePolicyRouter([mockTesseract, mockAppleVision]);
    const provider = await router.selectProvider({
      path: 'test.png',
      providerPreference: ['apple_vision', 'tesseract'],
    });
    expect(provider.id).toBe('tesseract');
  });

  it('routes to Apple Vision or Tesseract by default when no preferences are specified', async () => {
    const router = new AdaptivePolicyRouter([mockTesseract, mockAppleVision]);
    const provider = await router.selectProvider({
      path: 'test.png',
    });
    // Defaults to 'apple_vision' on balanced mode if available
    expect(provider.id).toBe('apple_vision');
  });

  it('throws an error if no registered provider is available', async () => {
    mockTesseract.isAvailable = vi.fn().mockResolvedValue(false);
    mockAppleVision.isAvailable = vi.fn().mockResolvedValue(false);
    const router = new AdaptivePolicyRouter([mockTesseract, mockAppleVision]);
    await expect(
      router.selectProvider({
        path: 'test.png',
      })
    ).rejects.toThrow('No available OCR provider could be resolved.');
  });

  it('keeps later providers available for recognition-time fallback', async () => {
    const failingProvider: OcrProvider = {
      id: 'apple_vision',
      dataEgress: 'none' as const,
      isAvailable: vi.fn().mockResolvedValue(true),
      recognize: vi.fn().mockRejectedValue(new Error('vision failed')),
    };
    const succeedingProvider: OcrProvider = {
      id: 'tesseract',
      dataEgress: 'none' as const,
      isAvailable: vi.fn().mockResolvedValue(true),
      recognize: vi.fn().mockResolvedValue({
        status: 'succeeded',
        provider: 'tesseract',
        text: 'fallback text',
        confidence: 91,
        elapsedMs: 3,
      }),
    };
    const router = new AdaptivePolicyRouter([failingProvider, succeedingProvider]);

    const result = await ocrImageWithRouter(
      { path: 'test.png', providerPreference: ['apple_vision'] },
      router
    );

    expect(result.provider).toBe('tesseract');
    expect(result.text).toBe('fallback text');
    expect(failingProvider.recognize).toHaveBeenCalledOnce();
    expect(succeedingProvider.recognize).toHaveBeenCalledOnce();
  });
});

describe('AppleVisionOcrProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createFakeChild() {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    fakeChild.stdout = new EventEmitter();
    fakeChild.stderr = new EventEmitter();
    fakeChild.kill = vi.fn();
    return fakeChild;
  }

  it('runs swift script to perform OCR on macOS', async () => {
    const fakeChild = createFakeChild();
    mocks.spawn.mockReturnValue(fakeChild);

    const provider = new AppleVisionOcrProvider();
    const promise = provider.recognize({ path: 'test.png' });

    fakeChild.stdout.emit(
      'data',
      JSON.stringify({
        status: 'succeeded',
        text: 'apple vision text',
        confidence: 98.5,
        lines: [{ text: 'apple vision text', confidence: 98.5 }],
      })
    );
    fakeChild.emit('close', 0);

    const result = await promise;
    expect(result.status).toBe('succeeded');
    expect(result.text).toBe('apple vision text');
    expect(result.confidence).toBe(98.5);
    expect(mocks.spawn).toHaveBeenCalledWith(
      'swift',
      expect.arrayContaining([
        expect.stringContaining('native-ocr.swift'),
        expect.stringContaining('test.png'),
      ]),
      expect.any(Object)
    );
  });

  it('kills process on safety timeout', async () => {
    const fakeChild = createFakeChild();
    mocks.spawn.mockReturnValue(fakeChild);

    const provider = new AppleVisionOcrProvider();
    const promise = provider.recognize({ path: 'test.png' });

    const assertionPromise = expect(promise).rejects.toThrow('apple_vision_ocr_timeout');

    await vi.advanceTimersByTimeAsync(16000);
    await assertionPromise;

    expect(fakeChild.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('TesseractOcrProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('terminates the worker even when recognition fails', async () => {
    const worker = {
      recognize: vi.fn().mockRejectedValue(new Error('tesseract failed')),
      terminate: vi.fn().mockResolvedValue(undefined),
    };
    tesseractMocks.createWorker.mockResolvedValue(worker);

    const provider = new TesseractOcrProvider();
    const result = await provider.recognize({ path: 'test.png' });

    expect(result.status).toBe('failed');
    expect(worker.recognize).toHaveBeenCalledOnce();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(tesseractMocks.createWorker).toHaveBeenCalledWith('eng');
  });
});

describe('LlmApiOcrProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    networkMocks.secureFetch.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
    global.fetch = globalFetch;
  });

  it('calls Gemini API if GEMINI_API_KEY is defined', async () => {
    process.env.GEMINI_API_KEY = 'mock-gemini-key';
    const mockResponse = {
      candidates: [{ content: { parts: [{ text: 'gemini ocr text' }] } }],
    };
    networkMocks.secureFetch.mockResolvedValue(mockResponse);

    const provider = new LlmApiOcrProvider();
    const result = await provider.recognize({ path: 'test.png' });

    expect(result.status).toBe('succeeded');
    expect(result.text).toBe('gemini ocr text');
    expect(result.provider).toBe('gemini_api');
    expect(networkMocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: expect.stringContaining('generativelanguage.googleapis.com'),
        authenticateRequest: true,
      })
    );
  });

  it('calls Claude API if ANTHROPIC_API_KEY is defined', async () => {
    process.env.ANTHROPIC_API_KEY = 'mock-claude-key';
    const mockResponse = {
      content: [{ text: 'claude ocr text' }],
    };
    networkMocks.secureFetch.mockResolvedValue(mockResponse);

    const provider = new LlmApiOcrProvider();
    const result = await provider.recognize({ path: 'test.png', providerPreference: ['claude'] });

    expect(result.status).toBe('succeeded');
    expect(result.text).toBe('claude ocr text');
    expect(result.provider).toBe('claude_api');
    expect(networkMocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.anthropic.com/v1/messages',
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'mock-claude-key',
        }),
        authenticateRequest: true,
      })
    );
  });

  it('calls OpenAI API if OPENAI_API_KEY is defined', async () => {
    process.env.OPENAI_API_KEY = 'mock-openai-key';
    const mockResponse = {
      choices: [{ message: { content: 'openai ocr text' } }],
    };
    networkMocks.secureFetch.mockResolvedValue(mockResponse);

    const provider = new LlmApiOcrProvider();
    const result = await provider.recognize({ path: 'test.png', providerPreference: ['openai'] });

    expect(result.status).toBe('succeeded');
    expect(result.text).toBe('openai ocr text');
    expect(result.provider).toBe('openai_api');
    expect(networkMocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.openai.com/v1/chat/completions',
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer mock-openai-key',
        }),
        authenticateRequest: true,
      })
    );
  });

  it('fails closed when a cloud provider returns an invalid response shape', async () => {
    process.env.GEMINI_API_KEY = 'mock-gemini-key';
    networkMocks.secureFetch.mockResolvedValue({ candidates: [{ content: { parts: [{}] } }] });

    const provider = new LlmApiOcrProvider();
    await expect(provider.recognize({ path: 'test.png' })).rejects.toThrow(
      'gemini_ocr_invalid_response'
    );
  });
});

describe('LocalVlmOcrProvider', () => {
  beforeEach(() => {
    networkMocks.secureFetch.mockReset();
  });

  afterEach(() => {
    global.fetch = globalFetch;
  });

  it('calls local VLM endpoint', async () => {
    const mockResponse = { response: 'local vlm ocr text' };
    networkMocks.secureFetch.mockResolvedValue(mockResponse);

    const provider = new LocalVlmOcrProvider(
      'http://localhost:11434/api/generate',
      'llama3-vision'
    );
    const result = await provider.recognize({ path: 'test.png' });

    expect(result.status).toBe('succeeded');
    expect(result.text).toBe('local vlm ocr text');
    expect(result.provider).toBe('local_vlm');
    expect(networkMocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://localhost:11434/api/generate',
        method: 'POST',
        data: expect.objectContaining({ model: 'llama3-vision' }),
        kyberion_allow_local_network: true,
      })
    );
  });

  it('fails closed when the local VLM response is not a text envelope', async () => {
    networkMocks.secureFetch.mockResolvedValue({ response: ['not text'] });

    const provider = new LocalVlmOcrProvider();
    await expect(provider.recognize({ path: 'test.png' })).rejects.toThrow(
      'local_vlm_ocr_invalid_response'
    );
  });
});

describe('OCR response parsers', () => {
  it('accepts only the expected provider text paths', () => {
    expect(
      parseGeminiOcrResponse({ candidates: [{ content: { parts: [{ text: 'gemini' }] } }] })
    ).toBe('gemini');
    expect(parseClaudeOcrResponse({ content: [{ text: 'claude' }] })).toBe('claude');
    expect(parseOpenAiOcrResponse({ choices: [{ message: { content: 'openai' } }] })).toBe(
      'openai'
    );
    expect(parseLocalVlmOcrResponse({ response: 'local' })).toBe('local');
    expect(parseGeminiOcrResponse([])).toBeUndefined();
    expect(parseClaudeOcrResponse({ content: [{ text: 1 }] })).toBeUndefined();
    expect(parseOpenAiOcrResponse({ choices: [{ message: { content: [] } }] })).toBeUndefined();
    expect(parseLocalVlmOcrResponse({ response: null })).toBeUndefined();
  });
});

describe('OCR egress capability routing', () => {
  const local = (id: string): OcrProvider => ({
    id,
    dataEgress: 'none',
    isAvailable: vi.fn().mockResolvedValue(true),
    recognize: vi.fn().mockResolvedValue({
      status: 'succeeded',
      provider: id,
      text: 'ok',
      confidence: 90,
      elapsedMs: 1,
    }),
  });
  const cloud = (id: string): OcrProvider => ({
    id,
    dataEgress: 'external',
    isAvailable: vi.fn().mockResolvedValue(true),
    recognize: vi.fn().mockResolvedValue({
      status: 'succeeded',
      provider: id,
      text: 'ok',
      confidence: 99,
      elapsedMs: 1,
    }),
  });
  const loopback = (id: string): OcrProvider => ({
    id,
    dataEgress: 'loopback',
    isAvailable: vi.fn().mockResolvedValue(true),
    recognize: vi.fn().mockResolvedValue({
      status: 'succeeded',
      provider: id,
      text: 'ok',
      confidence: 80,
      elapsedMs: 1,
    }),
  });

  it('excludes an external provider under local_only even when it is preferred', async () => {
    const router = new AdaptivePolicyRouter([cloud('llm_api'), local('apple_vision')]);

    const candidates = await router.resolveCandidates({
      path: 'test.png',
      mode: 'local_only',
      providerPreference: ['llm_api'],
    });

    expect(candidates.map((p) => p.id)).toEqual(['apple_vision']);
  });

  it('excludes a loopback provider under local_only but allows it under privacy_first', async () => {
    const router = new AdaptivePolicyRouter([loopback('local_vlm'), local('tesseract')]);

    const strict = await router.resolveCandidates({ path: 'test.png', mode: 'local_only' });
    const privacy = await router.resolveCandidates({ path: 'test.png', mode: 'privacy_first' });

    expect(strict.map((p) => p.id)).toEqual(['tesseract']);
    expect(privacy.map((p) => p.id)).toContain('local_vlm');
  });

  it('routes to an unlisted local provider rather than falling back to an external one', async () => {
    // A provider added later without being written into any hand-kept chain.
    const router = new AdaptivePolicyRouter([cloud('llm_api'), local('some_new_os_ocr')]);

    const candidates = await router.resolveCandidates({ path: 'test.png', mode: 'local_only' });

    expect(candidates.map((p) => p.id)).toEqual(['some_new_os_ocr']);
  });

  it('fails closed when no local provider is available under local_only', async () => {
    const router = new AdaptivePolicyRouter([cloud('llm_api')]);

    await expect(
      ocrImageWithRouter({ path: 'test.png', mode: 'local_only' }, router)
    ).rejects.toThrow('No available OCR provider');
  });

  it('stamps the served egress on the result so callers can assert it', async () => {
    const router = new AdaptivePolicyRouter([local('apple_vision')]);

    const result = await ocrImageWithRouter({ path: 'test.png', mode: 'local_only' }, router);

    expect(result.providerDataEgress).toBe('none');
  });

  it('classifies the local VLM by its resolved endpoint, not by its name', async () => {
    const previous = process.env.OLLAMA_HOST;
    try {
      process.env.OLLAMA_HOST = 'http://gpu-box.internal:11434';
      expect(new LocalVlmOcrProvider().dataEgress).toBe('external');
      process.env.OLLAMA_HOST = 'http://127.0.0.1:11434';
      expect(new LocalVlmOcrProvider().dataEgress).toBe('loopback');
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_HOST;
      else process.env.OLLAMA_HOST = previous;
    }
  });
});

describe('OCR input path boundary', () => {
  it('rejects an external image path before any provider reads or executes it', async () => {
    const native = await import('./windows-native-image-recognition-bridge.js');
    expect(() => native.recognizeTextWithWindowsNativeApi('/tmp/outside-ocr.png')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
    expect(() => native.describeImageWithWindowsNativeApi('/tmp/outside-ocr.png')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );

    const providers = [
      new WindowsNativeOcrProvider(),
      new TesseractOcrProvider(),
      new AppleVisionOcrProvider(),
      new LlmApiOcrProvider(),
      new LocalVlmOcrProvider(),
    ];

    for (const provider of providers) {
      await expect(provider.recognize({ path: '/tmp/outside-ocr.png' })).rejects.toThrow(
        '[RESOURCE_PATH_SCOPE]'
      );
    }
  });
});
