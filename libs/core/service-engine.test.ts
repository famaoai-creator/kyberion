import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeExec: vi.fn(),
  resolveServiceBinding: vi.fn(() => ({ accessToken: 'test-token' })),
  checkBinary: vi.fn(),
  secureFetch: vi.fn(),
  resolveOverlay: vi.fn(() => null),
}));

vi.mock('./index.js', async () => {
  const actual = (await vi.importActual('./index.js')) as any;
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

vi.mock('./customer-resolver.js', () => ({
  resolveOverlay: mocks.resolveOverlay,
}));

describe('executeServicePreset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KYBERION_ALLOW_UNSAFE_CLI = 'true';
    delete process.env.KYBERION_CUSTOMER;
    mocks.resolveServiceBinding.mockReturnValue({ accessToken: 'test-token' });
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

    await expect(executeServicePreset('test-service', 'do_action', {}, 'none')).resolves.toEqual({
      res: 'api-success',
    });
  });

  it('prefers a customer overlay connection when active', async () => {
    process.env.KYBERION_CUSTOMER = 'acme';
    mocks.resolveOverlay.mockReturnValue('/virtual/customer/acme/connections/slack.json');

    const { executeServicePreset } = await import('./service-engine.js');
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-endpoints.json')) {
        return JSON.stringify({
          services: {
            slack: { preset_path: 'slack.json', base_url: 'https://api.example.com' },
          },
        });
      }
      if (filePath.includes('customer/acme/connections/slack.json')) {
        return JSON.stringify({
          path_segment: 'customer-route',
          token: 'customer-token',
        });
      }
      if (filePath.includes('slack.json')) {
        return JSON.stringify({
          operations: {
            post_message: {
              type: 'api',
              path: '{{path_segment}}',
              method: 'POST',
            },
          },
        });
      }
      return '';
    });
    mocks.secureFetch.mockResolvedValue({ ok: true });

    await executeServicePreset('slack', 'post_message', { text: 'hello' }, 'none');

    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.example.com/customer-route',
        data: { text: 'hello' },
        params: undefined,
      }),
    );
  });

  it('falls back to personal connection when no customer overlay exists', async () => {
    process.env.KYBERION_CUSTOMER = 'acme';
    mocks.resolveOverlay.mockReturnValue('/virtual/customer/acme/connections/slack.json');

    const { executeServicePreset } = await import('./service-engine.js');
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-endpoints.json')) {
        return JSON.stringify({
          services: {
            slack: { preset_path: 'slack.json', base_url: 'https://api.example.com' },
          },
        });
      }
      if (filePath.includes('customer/acme/connections/slack.json')) {
        throw new Error('missing overlay');
      }
      if (filePath.includes('knowledge/personal/connections/slack.json')) {
        return JSON.stringify({
          path_segment: 'personal-route',
          token: 'personal-token',
        });
      }
      if (filePath.includes('slack.json')) {
        return JSON.stringify({
          operations: {
            post_message: {
              type: 'api',
              path: '{{path_segment}}',
              method: 'POST',
            },
          },
        });
      }
      return '';
    });
    mocks.secureFetch.mockResolvedValue({ ok: true });

    await executeServicePreset('slack', 'post_message', { text: 'hello' }, 'none');

    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.example.com/personal-route',
      }),
    );
  });

  it('supports media-generation workflow prompts through structured API payloads', async () => {
    const { executeServicePreset } = await import('./service-engine.js');
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-endpoints.json')) {
        return JSON.stringify({
          services: {
            'media-generation': {
              preset_path: 'knowledge/public/orchestration/service-presets/media-generation.json',
              base_url: 'http://127.0.0.1:8188',
            },
          },
        });
      }
      if (filePath.includes('media-generation.json')) {
        return JSON.stringify({
          base_url: 'http://127.0.0.1:8188',
          operations: {
            generate_video: {
              type: 'api',
              path: 'prompt',
              method: 'POST',
              payload_template: { prompt: '{{workflow}}' },
              output_mapping: { prompt_id: 'prompt_id' },
            },
          },
        });
      }
      return '';
    });
    mocks.secureFetch.mockResolvedValue({ prompt_id: 'vid-123' });

    await expect(
      executeServicePreset(
        'media-generation',
        'generate_video',
        { workflow: { nodeA: { class_type: 'KSampler' } } },
        'none'
      )
    ).resolves.toEqual({ prompt_id: 'vid-123' });

    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://127.0.0.1:8188/prompt',
        data: {
          prompt: { nodeA: { class_type: 'KSampler' } },
        },
      })
    );
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
      executeServicePreset('vision', 'capture_screen', { output: '/tmp/screen.jpg' }, 'none')
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
          auth_strategy: 'Bearer',
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

    await executeServicePreset(
      'notion',
      'create_page',
      { database_id: 'db1', title: 'hello' },
      'secret-guard'
    );

    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.notion.com/v1/pages',
        data: {
          parent: { database_id: 'db1' },
          properties: { Name: { title: [{ text: { content: 'hello' } }] } },
        },
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      })
    );
  });

  it('builds basic auth headers from client credentials and encodes form payloads', async () => {
    mocks.resolveServiceBinding.mockReturnValue({
      serviceId: 'canva',
      clientId: 'client-id',
      clientSecret: 'cnvca-test-secret',
    });

    const { executeServicePreset } = await import('./service-engine.js');
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-endpoints.json')) {
        return JSON.stringify({
          services: {
            canva: { preset_path: 'canva.json', base_url: 'https://api.canva.com/rest/v1' },
          },
        });
      }
      if (filePath.includes('canva.json')) {
        return JSON.stringify({
          auth_strategy: 'Bearer',
          operations: {
            exchange_oauth_code: {
              type: 'api',
              path: 'oauth/token',
              method: 'POST',
              auth_strategy: 'Basic',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              payload_template: {
                grant_type: 'authorization_code',
                code: '{{code}}',
                code_verifier: '{{code_verifier}}',
              },
            },
          },
        });
      }
      return '';
    });
    mocks.secureFetch.mockResolvedValue({ access_token: 'new-token' });

    await executeServicePreset(
      'canva',
      'exchange_oauth_code',
      {
        code: 'auth-code',
        code_verifier: 'verifier',
      },
      'secret-guard'
    );

    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.canva.com/rest/v1/oauth/token',
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('client-id:cnvca-test-secret', 'utf8').toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
        data: 'grant_type=authorization_code&code=auth-code&code_verifier=verifier',
      })
    );
  });

  it('stages a youtube upload package through the youtube service preset', async () => {
    const { executeServicePreset } = await import('./service-engine.js');
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('service-endpoints.json')) {
        return JSON.stringify({
          services: {
            youtube: { preset_path: 'knowledge/public/orchestration/service-presets/youtube.json' },
          },
        });
      }
      if (filePath.includes('youtube.json')) {
        return JSON.stringify({
          operations: {
            prepare_upload_package: {
              type: 'cli',
              command: 'node',
              args: [
                'dist/scripts/stage_youtube_upload_package.js',
                '{{publish_plan_path}}',
                '{{output_path}}',
              ],
            },
          },
        });
      }
      return '';
    });
    mocks.checkBinary.mockResolvedValue(true);
    mocks.safeExec.mockReturnValue(
      JSON.stringify({
        status: 'succeeded',
        output: 'active/shared/runtime/youtube/upload-packages/kyberion.json',
      })
    );

    await expect(
      executeServicePreset('youtube', 'prepare_upload_package', {
        publish_plan_path: 'knowledge/public/schemas/narrated-video-publish-plan.example.json',
        output_path: 'active/shared/runtime/youtube/upload-packages/kyberion.json',
      })
    ).resolves.toEqual({
      status: 'succeeded',
      output: 'active/shared/runtime/youtube/upload-packages/kyberion.json',
    });

    expect(mocks.safeExec).toHaveBeenCalledWith('node', [
      'dist/scripts/stage_youtube_upload_package.js',
      'knowledge/public/schemas/narrated-video-publish-plan.example.json',
      'active/shared/runtime/youtube/upload-packages/kyberion.json',
    ]);
  });
});
