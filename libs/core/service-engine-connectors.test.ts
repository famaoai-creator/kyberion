import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * DA-02 contract tests: the ingestion read-connectors (Box / Slack read ops /
 * Drive content / mail attachments) exercised through executeServicePreset
 * against the REAL preset + endpoint catalogs on disk, with the HTTP/CLI
 * transport mocked. Unlike service-engine.test.ts (which stubs the preset
 * JSON inline to test engine mechanics), these tests fail when the shipped
 * preset files regress.
 */

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(),
  resolveServiceBinding: vi.fn(() => ({ accessToken: 'test-token' })),
  checkBinary: vi.fn(),
  secureFetch: vi.fn(),
  resolveOverlay: vi.fn(() => null),
  retry: vi.fn(async (fn: () => Promise<unknown>, _options?: unknown) => fn()),
}));

vi.mock('./index.js', async () => {
  const actual = (await vi.importActual('./index.js')) as any;
  return {
    ...actual,
    safeExec: mocks.safeExec,
    resolveServiceBinding: mocks.resolveServiceBinding,
    secureFetch: mocks.secureFetch,
    retry: mocks.retry,
    platform: {
      ...actual.platform,
      checkBinary: mocks.checkBinary,
    },
  };
});

vi.mock('./async-utils.js', () => ({
  retry: mocks.retry,
}));

vi.mock('./network.js', async () => {
  const actual = await vi.importActual<typeof import('./network.js')>('./network.js');
  return { ...actual, secureFetch: mocks.secureFetch };
});

vi.mock('./platform.js', async () => {
  const actual = await vi.importActual<typeof import('./platform.js')>('./platform.js');
  return { ...actual, checkBinary: mocks.checkBinary };
});

vi.mock('./secure-io.js', async () => {
  const actual = await vi.importActual<typeof import('./secure-io.js')>('./secure-io.js');
  return { ...actual, safeExec: mocks.safeExec };
});

vi.mock('./customer-resolver.js', () => ({
  resolveOverlay: mocks.resolveOverlay,
}));

vi.mock('./service-binding.js', async () => {
  const actual = (await vi.importActual('./service-binding.js')) as any;
  return {
    ...actual,
    resolveServiceBinding: mocks.resolveServiceBinding,
  };
});

describe('DA-02 extraction connector presets (real catalog contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.KYBERION_ALLOW_UNSAFE_CLI = 'true';
    delete process.env.KYBERION_CUSTOMER;
    delete process.env.KYBERION_SERVICE_ENDPOINTS_PATH;
    delete process.env.KYBERION_SERVICE_ENDPOINTS_DIR;
    delete process.env.KYBERION_SERVICE_PRESETS_DIR;
    mocks.resolveServiceBinding.mockReturnValue({ accessToken: 'test-token' });
    mocks.resolveOverlay.mockReturnValue(null);
  });

  describe('box preset (new)', () => {
    it('registers box in the endpoint catalog with a preset path and Bearer strategy', async () => {
      const { loadServiceEndpointsCatalog } = (await vi.importActual(
        './service-endpoint-registry.js'
      )) as any;
      const record = loadServiceEndpointsCatalog().services.box;
      expect(record).toBeDefined();
      expect(record.base_url).toBe('https://api.box.com/2.0');
      expect(record.preset_path).toBe('knowledge/product/orchestration/service-presets/box.json');
    });

    it('lists folder items with marker-based pagination params and Bearer auth', async () => {
      const { executeServicePreset } = await import('./service-engine.js');
      mocks.secureFetch.mockResolvedValue({ entries: [], next_marker: 'marker-2' });

      await expect(
        executeServicePreset(
          'box',
          'get_folder_items',
          {
            folder_id: '0',
            query: { limit: 100, usemarker: true, marker: 'marker-1' },
          },
          'secret-guard'
        )
      ).resolves.toEqual({ entries: [], next_marker: 'marker-2' });

      expect(mocks.secureFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: 'https://api.box.com/2.0/folders/0/items',
          params: expect.objectContaining({ limit: 100, usemarker: true, marker: 'marker-1' }),
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
          authenticateRequest: true,
        })
      );
    });

    it('fetches file info by id', async () => {
      const { executeServicePreset } = await import('./service-engine.js');
      mocks.secureFetch.mockResolvedValue({ id: '123', etag: '1' });

      await executeServicePreset(
        'box',
        'get_file_info',
        { file_id: '123', query: { fields: 'id,name,etag,sha1,modified_at' } },
        'secret-guard'
      );

      expect(mocks.secureFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: 'https://api.box.com/2.0/files/123',
          params: expect.objectContaining({ fields: 'id,name,etag,sha1,modified_at' }),
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        })
      );
    });

    it('downloads file content from the /content path', async () => {
      const { executeServicePreset } = await import('./service-engine.js');
      mocks.secureFetch.mockResolvedValue('binary-bytes');

      await executeServicePreset('box', 'download_file', { file_id: '123' }, 'secret-guard');

      expect(mocks.secureFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: 'https://api.box.com/2.0/files/123/content',
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        })
      );
    });

    it('searches content with query params', async () => {
      const { executeServicePreset } = await import('./service-engine.js');
      mocks.secureFetch.mockResolvedValue({ entries: [] });

      await executeServicePreset(
        'box',
        'search',
        { query: { query: 'contract', type: 'file', limit: 30, offset: 0 } },
        'secret-guard'
      );

      expect(mocks.secureFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: 'https://api.box.com/2.0/search',
          params: expect.objectContaining({ query: 'contract', type: 'file' }),
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        })
      );
    });

    it('carries the confluence-style recovery policy into retry options', async () => {
      const { executeServicePreset } = await import('./service-engine.js');
      mocks.secureFetch.mockResolvedValue({ entries: [] });

      await executeServicePreset('box', 'get_folder_items', { folder_id: '0' }, 'secret-guard');

      expect(mocks.retry).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          maxRetries: 3,
          initialDelayMs: 500,
          maxDelayMs: 10000,
          factor: 2,
          jitter: true,
          shouldRetry: expect.any(Function),
        })
      );
    });
  });

  describe('slack read ops (added to slack.json)', () => {
    it('fetches conversations.history as GET with channel/cursor/oldest/limit query', async () => {
      const { executeServicePreset } = await import('./service-engine.js');
      mocks.secureFetch.mockResolvedValue({ ok: true, messages: [] });

      await executeServicePreset(
        'slack',
        'conversations_history',
        { query: { channel: 'C123', cursor: 'cur-1', oldest: '1720000000.000000', limit: 200 } },
        'secret-guard'
      );

      expect(mocks.secureFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: 'https://slack.com/api/conversations.history',
          params: expect.objectContaining({
            channel: 'C123',
            cursor: 'cur-1',
            oldest: '1720000000.000000',
            limit: 200,
          }),
          headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
        })
      );
    });

    it('fetches conversations.replies for a thread ts', async () => {
      const { executeServicePreset } = await import('./service-engine.js');
      mocks.secureFetch.mockResolvedValue({ ok: true, messages: [] });

      await executeServicePreset(
        'slack',
        'conversations_replies',
        { query: { channel: 'C123', ts: '1720000000.000100', cursor: 'cur-2' } },
        'secret-guard'
      );

      expect(mocks.secureFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: 'https://slack.com/api/conversations.replies',
          params: expect.objectContaining({
            channel: 'C123',
            ts: '1720000000.000100',
            cursor: 'cur-2',
          }),
        })
      );
    });

    it('lists files with channel/page query', async () => {
      const { executeServicePreset } = await import('./service-engine.js');
      mocks.secureFetch.mockResolvedValue({ ok: true, files: [] });

      await executeServicePreset(
        'slack',
        'files_list',
        { query: { channel: 'C123', page: 2 } },
        'secret-guard'
      );

      expect(mocks.secureFetch).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          url: 'https://slack.com/api/files.list',
          params: expect.objectContaining({ channel: 'C123', page: 2 }),
        })
      );
    });

    it('keeps the existing post_message operation intact', async () => {
      const { getServicePresetRecord } = (await vi.importActual(
        './service-preset-registry.js'
      )) as any;
      const preset = getServicePresetRecord('slack');
      expect(preset.operations.post_message).toBeDefined();
      expect(preset.operations.post_message.alternatives?.[0]?.path).toBe('chat.postMessage');
    });
  });

  describe('google-workspace drive content + gmail attachment ops (gws CLI)', () => {
    beforeEach(() => {
      mocks.checkBinary.mockResolvedValue(true);
    });

    it('downloads drive file content through gws drive files get', async () => {
      const { executeServicePreset } = await import('./service-engine.js');
      mocks.safeExec.mockReturnValue(JSON.stringify({ status: 'ok' }));

      await executeServicePreset('google-workspace', 'drive_file_download', {
        params: { fileId: 'file-1', alt: 'media' },
      });

      expect(mocks.safeExec).toHaveBeenCalledWith('gws', [
        'drive',
        'files',
        'get',
        '--params',
        JSON.stringify({ fileId: 'file-1', alt: 'media' }),
      ]);
    });

    it('exports google-native docs through gws drive files export', async () => {
      const { executeServicePreset } = await import('./service-engine.js');
      mocks.safeExec.mockReturnValue(JSON.stringify({ status: 'ok' }));

      await executeServicePreset('google-workspace', 'drive_file_export', {
        params: { fileId: 'doc-1', mimeType: 'text/plain' },
      });

      expect(mocks.safeExec).toHaveBeenCalledWith('gws', [
        'drive',
        'files',
        'export',
        '--params',
        JSON.stringify({ fileId: 'doc-1', mimeType: 'text/plain' }),
      ]);
    });

    it('fetches gmail attachments through the discovery-backed attachments get', async () => {
      const { executeServicePreset } = await import('./service-engine.js');
      mocks.safeExec.mockReturnValue(JSON.stringify({ size: 1024, data: 'base64url-bytes' }));

      await executeServicePreset('google-workspace', 'gmail_attachment_get', {
        params: { messageId: 'msg-1', id: 'att-1' },
      });

      expect(mocks.safeExec).toHaveBeenCalledWith('gws', [
        'gmail',
        'users',
        'messages',
        'attachments',
        'get',
        '--params',
        JSON.stringify({ messageId: 'msg-1', id: 'att-1' }),
      ]);
    });

    it('marks unverified gws subcommands with a note field', async () => {
      const { getServicePresetRecord } = (await vi.importActual(
        './service-preset-registry.js'
      )) as any;
      const preset = getServicePresetRecord('google-workspace');
      for (const op of ['drive_file_download', 'drive_file_export', 'gmail_attachment_get']) {
        expect(preset.operations[op].note, `${op} must carry a CLI-verification note`).toMatch(
          /CLI verification|verify the installed gws CLI/i
        );
      }
    });
  });

  describe('m365 outlook attachment ops (m365 CLI)', () => {
    beforeEach(() => {
      mocks.checkBinary.mockResolvedValue(true);
    });

    it('lists outlook message attachments through graph', async () => {
      const { executeServicePreset } = await import('./service-engine.js');
      mocks.safeExec.mockReturnValue(JSON.stringify({ value: [] }));

      await executeServicePreset('m365', 'outlook_attachments_list', { message_id: 'msg-1' });

      expect(mocks.safeExec).toHaveBeenCalledWith('m365', [
        'request',
        '--url',
        '@graph/me/messages/msg-1/attachments',
        '--output',
        'json',
      ]);
    });

    it('fetches one outlook attachment by id through graph', async () => {
      const { executeServicePreset } = await import('./service-engine.js');
      mocks.safeExec.mockReturnValue(JSON.stringify({ id: 'att-1', contentBytes: 'base64-bytes' }));

      await executeServicePreset('m365', 'outlook_attachment_get', {
        message_id: 'msg-1',
        attachment_id: 'att-1',
      });

      expect(mocks.safeExec).toHaveBeenCalledWith('m365', [
        'request',
        '--url',
        '@graph/me/messages/msg-1/attachments/att-1',
        '--output',
        'json',
      ]);
    });
  });

  describe('egress gate coverage for the new HTTP connectors', () => {
    it('routes every box/slack read op host through an allowlisted egress domain', async () => {
      const { evaluateEgressPolicy, _resetEgressPolicyCacheForTests } = (await vi.importActual(
        './egress-policy.js'
      )) as any;
      _resetEgressPolicyCacheForTests();

      const urls = [
        'https://api.box.com/2.0/folders/0/items',
        'https://api.box.com/2.0/files/123',
        'https://api.box.com/2.0/files/123/content',
        'https://api.box.com/2.0/search',
        'https://slack.com/api/conversations.history',
        'https://slack.com/api/conversations.replies',
        'https://slack.com/api/files.list',
      ];
      for (const url of urls) {
        const decision = evaluateEgressPolicy(url);
        expect(decision.verdict, `${url} must be allowlisted`).toBe('allow');
      }
    });
  });
});
