import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  safeReadFile: vi.fn(),
  safeExistsSync: vi.fn(),
  createDraft: vi.fn(),
  sendEmail: vi.fn(),
  resolveVars: vi.fn((value: unknown) => value),
  retry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('@agent/core', async () => {
  const actual = (await vi.importActual('@agent/core')) as any;
  return {
    ...actual,
    safeReadFile: mocks.safeReadFile,
    safeExistsSync: mocks.safeExistsSync,
    createDraft: mocks.createDraft,
    sendEmail: mocks.sendEmail,
    resolveVars: mocks.resolveVars,
    retry: mocks.retry,
  };
});

describe('email-actuator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.safeExistsSync.mockReturnValue(true);
  });

  it('creates a draft from direct parameters', async () => {
    mocks.createDraft.mockResolvedValue({ message: 'draft-created' });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'create_draft',
      params: {
        to: 'alice@example.com',
        subject: 'Hello',
        body: 'Draft body',
      },
    });

    expect(mocks.createDraft).toHaveBeenCalledWith({
      to: 'alice@example.com',
      subject: 'Hello',
      body: 'Draft body',
    });
    expect(result).toEqual(expect.objectContaining({ status: 'succeeded' }));
  });

  it('reads body_file before sending', async () => {
    mocks.safeReadFile.mockReturnValue('Hello from file');
    mocks.sendEmail.mockResolvedValue({ message: 'sent' });

    const { handleAction } = await import('./index.js');
    const result = await handleAction({
      action: 'send_from_file',
      params: {
        to: 'bob@example.com',
        subject: 'File mail',
        body_file: 'docs/message.txt',
      },
    });

    expect(mocks.safeReadFile).toHaveBeenCalled();
    expect(mocks.sendEmail).toHaveBeenCalledWith({
      to: 'bob@example.com',
      subject: 'File mail',
      body_file: 'docs/message.txt',
      body: 'Hello from file',
    });
    expect(result).toEqual(expect.objectContaining({ status: 'succeeded' }));
  });

  it('rejects unknown operations', async () => {
    const { handleAction } = await import('./index.js');

    await expect(
      handleAction({
        action: 'forward',
        params: {
          to: 'carol@example.com',
          subject: 'Unsupported',
          body: 'No-op',
        },
      })
    ).rejects.toThrow('email-actuator: unknown op: forward');
  });
});
