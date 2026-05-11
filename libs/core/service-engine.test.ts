import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeExec: vi.fn(),
  resolveServiceBinding: vi.fn(() => ({ accessToken: 'test-token' })),
  checkBinary: vi.fn(),
  secureFetch: vi.fn(),
  resolveOverlay: vi.fn(() => null),
  loadServiceEndpointsCatalog: vi.fn(),
  withRetry: vi.fn(async (fn: () => Promise<unknown>, _options?: unknown) => fn()),
}));

vi.mock('./index.js', async () => {
  const actual = (await vi.importActual('./index.js')) as any;
  return {
    ...actual,
    safeReadFile: mocks.safeReadFile,
    safeExec: mocks.safeExec,
    resolveServiceBinding: mocks.resolveServiceBinding,
    secureFetch: mocks.secureFetch,
    loadServiceEndpointsCatalog: mocks.loadServiceEndpointsCatalog,
    withRetry: mocks.withRetry,
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
    mocks.loadServiceEndpointsCatalog.mockReturnValue({
      default_pattern: 'https://api.{service_id}.com/v1',
      services: {
        'test-service': { preset_path: 'mock/path.json', base_url: 'https://api.test.com' },
        slack: { preset_path: 'slack.json', base_url: 'https://api.example.com' },
        backlog: {
          preset_path: 'knowledge/public/orchestration/service-presets/backlog.json',
          base_url: 'https://{{space}}.backlog.com/api/v2',
          credential_suffixes: {
            accessToken: ['API_KEY'],
          },
        },
        'media-generation': {
          preset_path: 'knowledge/public/orchestration/service-presets/media-generation.json',
          base_url: 'http://127.0.0.1:8188',
        },
        vision: { preset_path: 'knowledge/public/orchestration/service-presets/vision.json' },
        voice: { preset_path: 'knowledge/public/orchestration/service-presets/voice.json' },
        'google-workspace': {
          preset_path: 'knowledge/public/orchestration/service-presets/google-workspace.json',
          allow_unsafe_cli: true,
        },
        notion: { preset_path: 'p.json', base_url: 'https://api.notion.com/v1' },
        canva: { preset_path: 'canva.json', base_url: 'https://api.canva.com/rest/v1' },
        youtube: { preset_path: 'knowledge/public/orchestration/service-presets/youtube.json' },
      },
    });
  });

  it('falls back to API when CLI binary is missing', async () => {
    const { executeServicePreset } = await import('./service-engine.js');
    mocks.safeReadFile.mockImplementation((filePath: string) => {
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

  it('supports api_key_query presets with envelope vars and query params', async () => {
    const { executeServicePreset } = await import('./service-engine.js');
    mocks.resolveServiceBinding.mockReturnValue({
      serviceId: 'backlog',
      accessToken: 'backlog-secret',
    });
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('backlog.json')) {
        return JSON.stringify({
          service_id: 'backlog',
          auth_strategy: 'api_key_query',
          auth_params: {
            key: 'apiKey',
            value: '{{accessToken}}',
          },
          operations: {
            get_issues: {
              type: 'api',
              path: 'issues',
              method: 'GET',
            },
          },
        });
      }
      return '';
    });
    mocks.secureFetch.mockResolvedValue({ issues: [{ id: 1 }] });

    await executeServicePreset(
      'backlog',
      'get_issues',
      {
        space: 'acme',
        query: {
          'projectId[]': [12345],
          count: 50,
        },
      },
      'secret-guard',
    );

    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://acme.backlog.com/api/v2/issues',
        params: expect.objectContaining({
          'projectId[]': [12345],
          count: 50,
          apiKey: 'backlog-secret',
        }),
        data: undefined,
      }),
    );
  });

  it('applies preset recovery policy to transient failures before falling back', async () => {
    const { executeServicePreset } = await import('./service-engine.js');
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('backlog.json')) {
        return JSON.stringify({
          service_id: 'backlog',
          auth_strategy: 'api_key_query',
          auth_params: {
            key: 'apiKey',
            value: '{{accessToken}}',
          },
          recovery_policy: {
            retry: {
              maxRetries: 5,
              initialDelayMs: 100,
              maxDelayMs: 5000,
              factor: 2,
              jitter: false,
            },
            retryable_categories: ['network', 'timeout'],
          },
          operations: {
            get_issues: {
              type: 'api',
              path: 'issues',
              method: 'GET',
            },
          },
        });
      }
      return '';
    });
    mocks.secureFetch.mockResolvedValue({ issues: [{ id: 1 }] });

    await executeServicePreset(
      'backlog',
      'get_issues',
      {
        space: 'acme',
        query: {
          count: 10,
        },
      },
      'secret-guard',
    );

    expect(mocks.withRetry).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        maxRetries: 5,
        initialDelayMs: 100,
        maxDelayMs: 5000,
        factor: 2,
        jitter: false,
        shouldRetry: expect.any(Function),
      }),
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

  it('executes google workspace helper commands through gws', async () => {
    const { executeServicePreset } = await import('./service-engine.js');
    mocks.safeReadFile.mockImplementation((filePath: string) => {
      if (filePath.includes('google-workspace.json')) {
        return JSON.stringify({
          auth_strategy: 'session',
          allow_unsafe_cli: true,
          operations: {
            drive_files_list: {
              type: 'cli',
              command: 'gws',
              args: ['drive', 'files', 'list', '--params', '{{params}}', '--page-all'],
            },
          },
        });
      }
      return '';
    });
    mocks.checkBinary.mockResolvedValue(true);
    mocks.safeExec.mockReturnValue(JSON.stringify({ files: [{ name: 'Q1 Budget' }] }));

    await expect(
      executeServicePreset('google-workspace', 'drive_files_list', {
        params: { pageSize: 5 },
      })
    ).resolves.toEqual({ files: [{ name: 'Q1 Budget' }] });

    expect(mocks.safeExec).toHaveBeenCalledWith('gws', [
      'drive',
      'files',
      'list',
      '--params',
      JSON.stringify({ pageSize: 5 }),
      '--page-all',
    ]);
  });
});
