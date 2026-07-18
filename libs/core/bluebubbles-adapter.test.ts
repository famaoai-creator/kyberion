import { describe, expect, it, vi } from 'vitest';
import {
  buildBlueBubblesTextRequest,
  downloadBlueBubblesAttachment,
  evaluateBlueBubblesConfiguration,
  parseBlueBubblesWebhook,
  pruneBlueBubblesAttachmentCache,
  resolveBlueBubblesConfig,
  sendBlueBubblesAttachment,
  sendBlueBubblesText,
  verifyBlueBubblesWebhookSecret,
} from './bluebubbles-adapter.js';
import { describeIMessageBridgeHealth } from './imessage-bridge.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

describe('bluebubbles-adapter', () => {
  it('evaluates missing and invalid configuration without exposing secrets', () => {
    expect(evaluateBlueBubblesConfiguration()).toMatchObject({
      configured: false,
      valid: false,
      detail: 'not_configured',
    });
    expect(
      evaluateBlueBubblesConfiguration({
        KYBERION_BLUEBUBBLES_URL: 'ftp://localhost:1234',
        KYBERION_BLUEBUBBLES_PASSWORD: 'secret',
      })
    ).toMatchObject({ configured: true, valid: false, detail: 'invalid_base_url' });
    expect(JSON.stringify(evaluateBlueBubblesConfiguration())).not.toContain('secret');
  });

  it('builds a password-bound text request without putting credentials in the body', () => {
    const config = resolveBlueBubblesConfig({
      KYBERION_BLUEBUBBLES_URL: 'https://bb.example.test/',
      KYBERION_BLUEBUBBLES_PASSWORD: 's3cret',
    });
    expect(config).not.toBeNull();
    const request = buildBlueBubblesTextRequest(config!, {
      chatGuid: 'iMessage;-;chat-guid',
      text: 'hello',
    });
    expect(request.url).toBe('https://bb.example.test/api/v1/message/text?password=s3cret');
    expect(request.init.method).toBe('POST');
    expect(request.init.body).toBe(
      JSON.stringify({ chatGuid: 'iMessage;-;chat-guid', text: 'hello', method: 'private-api' })
    );
    expect(request.init.body).not.toContain('s3cret');
  });

  it('sends through an injected fetch and classifies HTTP failures', async () => {
    const config = resolveBlueBubblesConfig({
      KYBERION_BLUEBUBBLES_URL: 'https://bb.example.test',
      KYBERION_BLUEBUBBLES_PASSWORD: 'secret',
    })!;
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    await expect(
      sendBlueBubblesText(config, { chatGuid: 'chat-1', text: 'ok' }, fetchImpl)
    ).resolves.toMatchObject({
      sent: true,
      chatGuid: 'chat-1',
    });
    const failingFetch = vi.fn(async () => ({ ok: false, status: 401 }) as Response);
    await expect(
      sendBlueBubblesText(config, { chatGuid: 'chat-1', text: 'ok' }, failingFetch)
    ).rejects.toThrow('HTTP 401');
  });

  it('aborts a provider call at the bounded timeout and exposes a transient error', async () => {
    const config = resolveBlueBubblesConfig({
      KYBERION_BLUEBUBBLES_URL: 'https://bb.example.test',
      KYBERION_BLUEBUBBLES_PASSWORD: 'secret',
    })!;
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('AbortError')));
        })
    );
    await expect(
      sendBlueBubblesText(config, { chatGuid: 'chat-1', text: 'hang' }, fetchImpl, 5)
    ).rejects.toThrow('timed out after 5ms');
  });

  it('sends bounded local attachments as multipart private-api requests', async () => {
    const config = resolveBlueBubblesConfig({
      KYBERION_BLUEBUBBLES_URL: 'https://bb.example.test',
      KYBERION_BLUEBUBBLES_PASSWORD: 'secret',
    })!;
    const filePath = pathResolver.sharedTmp(`bluebubbles-attachment-${process.pid}.txt`);
    safeWriteFile(filePath, 'attachment body');
    try {
      const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
        const form = init?.body as FormData;
        expect(init?.method).toBe('POST');
        expect(form.get('chatGuid')).toBe('chat-1');
        expect(form.get('message')).toBe('caption');
        expect(form.get('tempGuid')).toEqual(expect.any(String));
        expect(form.get('name')).toBe('attachment.txt');
        const attachment = form.get('attachment') as File;
        expect(attachment.name).toBe('attachment.txt');
        expect(attachment.size).toBe(Buffer.byteLength('attachment body'));
        return { ok: true, status: 200 } as Response;
      });
      await expect(
        sendBlueBubblesAttachment(
          config,
          { chatGuid: 'chat-1', filePath, filename: 'attachment.txt', message: 'caption' },
          fetchImpl
        )
      ).resolves.toMatchObject({ sent: true, filename: 'attachment.txt' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      safeRmSync(filePath, { force: true });
    }
  });

  it('downloads webhook attachments with bounded streaming storage', async () => {
    const config = resolveBlueBubblesConfig({
      KYBERION_BLUEBUBBLES_URL: 'https://bb.example.test',
      KYBERION_BLUEBUBBLES_PASSWORD: 'secret',
    })!;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://bb.example.test/api/v1/attachment/att-1/download?password=secret');
      expect(init?.method).toBe('GET');
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '4' },
      });
    });
    const downloaded = await downloadBlueBubblesAttachment(
      config,
      {
        attachmentGuid: 'att-1',
        storageKey: 'message-1',
        filename: '../photo.png',
        mimeType: 'image/png',
        maxBytes: 16,
      },
      fetchImpl
    );
    try {
      expect(downloaded).toMatchObject({
        downloaded: true,
        attachmentGuid: 'att-1',
        filename: 'photo.png',
        mimeType: 'image/png',
        size: 4,
      });
      expect(safeReadFile(downloaded.filePath, { encoding: null })).toEqual(
        Buffer.from([1, 2, 3, 4])
      );
    } finally {
      safeRmSync(pathResolver.resolve('active/shared/tmp/bluebubbles-attachments/message-1'), {
        recursive: true,
        force: true,
      });
    }
  });

  it('rejects an attachment whose declared or streamed size exceeds the bound', async () => {
    const config = resolveBlueBubblesConfig({
      KYBERION_BLUEBUBBLES_URL: 'https://bb.example.test',
      KYBERION_BLUEBUBBLES_PASSWORD: 'secret',
    })!;
    const oversized = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-length': '17' },
        })
    );
    await expect(
      downloadBlueBubblesAttachment(
        config,
        { attachmentGuid: 'att-large', storageKey: 'message-large', maxBytes: 16 },
        oversized
      )
    ).rejects.toThrow('exceeds the 16-byte limit');
    expect(oversized).toHaveBeenCalledTimes(1);
  });

  it('prunes only the BlueBubbles cache when aggregate size is exceeded', () => {
    const cacheDir = pathResolver.resolve('active/shared/tmp/bluebubbles-attachments/prune-test');
    const first = `${cacheDir}/first.bin`;
    const second = `${cacheDir}/second.bin`;
    safeWriteFile(first, Buffer.from([1, 2, 3, 4]));
    safeWriteFile(second, Buffer.from([5, 6, 7, 8]));
    try {
      const dryRun = pruneBlueBubblesAttachmentCache({
        maxBytes: 4,
        ttlMs: 24 * 60 * 60 * 1000,
        dryRun: true,
      });
      expect(dryRun.scanned).toEqual(expect.arrayContaining([first, second]));
      expect(dryRun.deleted).toHaveLength(0);
      expect(dryRun.bytesBefore).toBe(8);
      expect(dryRun.bytesAfter).toBe(4);

      const result = pruneBlueBubblesAttachmentCache({
        maxBytes: 4,
        ttlMs: 24 * 60 * 60 * 1000,
      });
      expect(result.deleted).toHaveLength(1);
      expect(safeExistsSync(result.deleted[0])).toBe(false);
      expect(safeExistsSync(first) !== safeExistsSync(second)).toBe(true);
    } finally {
      safeRmSync(pathResolver.resolve('active/shared/tmp/bluebubbles-attachments/prune-test'), {
        recursive: true,
        force: true,
      });
    }
  });

  it('does not expose attachment capability for the AppleScript method', () => {
    expect(
      evaluateBlueBubblesConfiguration({
        KYBERION_BLUEBUBBLES_URL: 'https://bb.example.test',
        KYBERION_BLUEBUBBLES_PASSWORD: 'password',
        KYBERION_BLUEBUBBLES_SEND_METHOD: 'imessage',
      }).capabilities.send_attachments
    ).toBe(false);
  });

  it('normalizes new-message webhooks and rejects unrelated events or own messages', () => {
    const message = parseBlueBubblesWebhook({
      type: 'new-message',
      data: {
        guid: 'msg-1',
        text: 'Kyberion hello',
        handle: '+81-1',
        dateCreated: '2026-07-18T00:00:00.000Z',
        chats: [{ guid: 'chat-group', participants: ['a', 'b'] }],
        attachments: [{ guid: 'att-1', filename: 'photo.jpg', mime_type: 'image/jpeg' }],
      },
    });
    expect(message).toMatchObject({
      id: 'msg-1',
      sender: '+81-1',
      chatId: 'chat-group',
      chatGuid: 'chat-group',
      isGroup: true,
      attachments: [{ id: 'att-1', filename: 'photo.jpg', mimeType: 'image/jpeg' }],
    });
    expect(parseBlueBubblesWebhook({ type: 'message-updated', data: {} })).toBeNull();
    expect(
      parseBlueBubblesWebhook({
        type: 'new-message',
        data: { isFromMe: true, chats: [{ guid: 'chat' }] },
      })
    ).toBeNull();
  });

  it('exposes a non-secret BlueBubbles capability report through bridge health', () => {
    vi.stubEnv('KYBERION_BLUEBUBBLES_URL', 'https://bb.example.test');
    vi.stubEnv('KYBERION_BLUEBUBBLES_PASSWORD', 'health-test-secret');
    try {
      const health = describeIMessageBridgeHealth();
      expect(health.bluebubbles).toMatchObject({
        configured: true,
        valid: true,
        detail: 'configured',
        baseUrl: 'https://bb.example.test',
      });
      expect(JSON.stringify(health)).not.toContain('health-test-secret');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('requires the bridge-owned webhook secret and compares it safely', () => {
    expect(verifyBlueBubblesWebhookSecret('hook-secret', 'hook-secret')).toBe(true);
    expect(verifyBlueBubblesWebhookSecret('hook-secret', 'wrong-secret')).toBe(false);
    expect(verifyBlueBubblesWebhookSecret(undefined, 'hook-secret')).toBe(false);
    expect(
      evaluateBlueBubblesConfiguration({
        KYBERION_BLUEBUBBLES_URL: 'https://bb.example.test',
        KYBERION_BLUEBUBBLES_PASSWORD: 'password',
      }).capabilities.receive_webhooks
    ).toBe(false);
    expect(
      evaluateBlueBubblesConfiguration({
        KYBERION_BLUEBUBBLES_URL: 'https://bb.example.test',
        KYBERION_BLUEBUBBLES_PASSWORD: 'password',
        KYBERION_BLUEBUBBLES_WEBHOOK_SECRET: 'hook-secret',
      }).capabilities.receive_webhooks
    ).toBe(true);
  });
});
