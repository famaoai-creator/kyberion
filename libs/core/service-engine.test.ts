import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeExec: vi.fn(),
  resolveServiceBinding: vi.fn(() => ({ accessToken: 'test-token' })),
  checkBinary: vi.fn(),
  secureFetch: vi.fn(),
}));

vi.mock('./index.js', async () => {
  const actual = await vi.importActual('./index.js') as any;
  return {
    ...actual,
    safeReadFile: mocks.safeReadFile,
    safeExec: mocks.safeExec,
    resolveServiceBinding: mocks.resolveServiceBinding,
    secureFetch: mocks.secureFetch,
    platform: {
      ...actual.platform,
      checkBinary: mocks.checkBinary,
    },
  };
});

describe('executeServicePreset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KYBERION_ALLOW_UNSAFE_CLI = 'true';
  });

  it('falls back to API when CLI binary is missing', async () => {
    const { executeServicePreset } = await import('./service-engine.js');
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-endpoints.json')) {
        return JSON.stringify({
          services: {
            'test-service': { preset_path: 'mock/path.json', base_url: 'https://api.test.com' },
          },
        });
      }
      if (filePath.includes('mock/path.json')) {
        return JSON.stringify({
          operations: {
            do_action: {
              type: 'auto',
              alternatives: [
                { type: 'cli', command: 'missing-cli', args: ['run'] },
                { type: 'api', path: 'action', method: 'GET', output_mapping: { res: 'data.id' } },
              ],
            },
          },
        });
      }
      return '';
    });
    mocks.checkBinary.mockResolvedValue(false);
    mocks.secureFetch.mockResolvedValue({ data: { id: 'api-success' } });

    await expect(executeServicePreset('test-service', 'do_action', {}, 'none')).resolves.toEqual({ res: 'api-success' });
  });

  it('returns raw output when no output mapping is configured', async () => {
    const { executeServicePreset } = await import('./service-engine.js');
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-endpoints.json')) {
        return JSON.stringify({
          services: {
            vision: { preset_path: 'knowledge/public/orchestration/service-presets/vision.json' },
          },
        });
      }
      if (filePath.includes('vision.json')) {
        return JSON.stringify({
          operations: {
            capture_screen: {
              type: 'cli',
              command: 'screencapture',
              args: ['-x', '-t', 'jpg', '{{output}}'],
            },
          },
        });
      }
      return '';
    });
    mocks.checkBinary.mockResolvedValue(true);
    mocks.safeExec.mockReturnValue('/tmp/screen.jpg');

    await expect(
      executeServicePreset('vision', 'capture_screen', { output: '/tmp/screen.jpg' }, 'none'),
    ).resolves.toBe('/tmp/screen.jpg');
  });

  it('preserves structured values in CLI templates', async () => {
    const { executeServicePreset } = await import('./service-engine.js');
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-endpoints.json')) {
        return JSON.stringify({
          services: {
            voice: { preset_path: 'knowledge/public/orchestration/service-presets/voice.json' },
          },
        });
      }
      if (filePath.includes('voice.json')) {
        return JSON.stringify({
          operations: {
            speak_local: {
              type: 'cli',
              command: 'python3',
              args: ['voice-bridge.py', { action: 'speak', params: '{{params}}' }],
            },
          },
        });
      }
      return '';
    });
    mocks.checkBinary.mockResolvedValue(true);
    mocks.safeExec.mockReturnValue(JSON.stringify({ ok: true }));

    await executeServicePreset('voice', 'speak_local', { params: { text: 'hello' } }, 'none');

    expect(mocks.safeExec).toHaveBeenCalledWith('python3', [
      'voice-bridge.py',
      JSON.stringify({ action: 'speak', params: { text: 'hello' } }),
    ]);
  });

  it('resolves API payload templates without JSON string hacks', async () => {
    const { executeServicePreset } = await import('./service-engine.js');
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-endpoints.json')) {
        return JSON.stringify({
          services: {
            notion: { preset_path: 'p.json', base_url: 'https://api.notion.com/v1' },
          },
        });
      }
      if (filePath.includes('p.json')) {
        return JSON.stringify({
          operations: {
            create_page: {
              type: 'api',
              path: 'pages',
              method: 'POST',
              payload_template: {
                parent: { database_id: '{{database_id}}' },
                properties: { Name: { title: [{ text: { content: '{{title}}' } }] } },
              },
            },
          },
        });
      }
      return '';
    });
    mocks.secureFetch.mockResolvedValue({ ok: true });

    await executeServicePreset('notion', 'create_page', { database_id: 'db1', title: 'hello' }, 'secret-guard');

    expect(mocks.secureFetch).toHaveBeenCalledWith(expect.objectContaining({
      url: 'https://api.notion.com/v1/pages',
      data: {
        parent: { database_id: 'db1' },
        properties: { Name: { title: [{ text: { content: 'hello' } }] } },
      },
      headers: expect.objectContaining({
        Authorization: 'Bearer test-token',
      }),
    }));
  });
});
