import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  EmailBackendRegistry,
  EmailPolicyRouter,
  MacMailAppEmailProvider,
  SmtpEmailProvider,
} from './email-bridge.js';
import { EmailProvider } from './email-types.js';

const mocks = vi.hoisted(() => {
  const spawn = vi.fn();
  return { spawn };
});

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
}));

describe('EmailPolicyRouter', () => {
  let mockMacMail: EmailProvider;
  let mockSmtp: EmailProvider;

  beforeEach(() => {
    mockMacMail = {
      id: 'mac_mailapp',
      isAvailable: vi.fn().mockResolvedValue(true),
      send: vi.fn(),
      createDraft: vi.fn(),
    };
    mockSmtp = {
      id: 'smtp',
      isAvailable: vi.fn().mockResolvedValue(true),
      send: vi.fn(),
      createDraft: vi.fn(),
    };
  });

  it('selects mac_mailapp for create_draft if available', async () => {
    const router = new EmailPolicyRouter([mockMacMail, mockSmtp]);
    const provider = await router.selectProvider('create_draft');
    expect(provider.id).toBe('mac_mailapp');
  });

  it('selects smtp for send if it is available', async () => {
    const router = new EmailPolicyRouter([mockMacMail, mockSmtp]);
    const provider = await router.selectProvider('send');
    expect(provider.id).toBe('smtp');
  });

  it('falls back to mac_mailapp for send if smtp is not available', async () => {
    mockSmtp.isAvailable = vi.fn().mockResolvedValue(false);
    const router = new EmailPolicyRouter([mockMacMail, mockSmtp]);
    const provider = await router.selectProvider('send');
    expect(provider.id).toBe('mac_mailapp');
  });

  it('supports explicit backend selection without caller-specific branches', async () => {
    const router = new EmailPolicyRouter([mockMacMail, mockSmtp]);
    await expect(router.selectProvider('send', 'smtp')).resolves.toBe(mockSmtp);
    await expect(router.selectProvider('create_draft', 'smtp')).rejects.toThrow(
      /not available|does not support draft creation/i
    );
  });

  it('resolves a newly registered backend through the same registry contract', async () => {
    const outlook: EmailProvider = {
      id: 'outlook',
      isAvailable: vi.fn().mockResolvedValue(true),
      send: vi.fn(),
      createDraft: vi.fn(),
    };
    const registry = new EmailBackendRegistry([outlook]);
    await expect(registry.resolve('outlook', 'send')).resolves.toBe(outlook);
  });
});

describe('MacMailAppEmailProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('spawns osascript to execute JXA script for mail operations', async () => {
    const fakeChild = createFakeChild();
    mocks.spawn.mockReturnValue(fakeChild);

    const provider = new MacMailAppEmailProvider();
    const promise = provider.send({
      to: 'test@example.com',
      subject: 'Hello',
      body: 'World',
    });

    fakeChild.stdout.emit('data', 'ok');
    fakeChild.emit('close', 0);

    const result = await promise;
    expect(result.status).toBe('succeeded');
    expect(result.provider).toBe('mac_mailapp');
    expect(mocks.spawn).toHaveBeenCalledWith(
      'osascript',
      expect.arrayContaining([
        '-l',
        'JavaScript',
        '-e',
        expect.stringContaining("Application('Mail')"),
      ]),
      expect.any(Object)
    );
  });
});

describe('SmtpEmailProvider', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
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

  it('spawns python3 to execute SMTP sending script', async () => {
    process.env.KYBERION_SMTP_HOST = 'smtp.example.com';
    process.env.KYBERION_SMTP_USER = 'user';
    process.env.KYBERION_SMTP_PASS = 'pass';

    const fakeChild = createFakeChild();
    mocks.spawn.mockReturnValue(fakeChild);

    const provider = new SmtpEmailProvider();
    const promise = provider.send({
      to: 'recipient@example.com',
      subject: 'SMTP Alert',
      body: 'Details',
    });

    fakeChild.stdout.emit('data', 'ok');
    fakeChild.emit('close', 0);

    const result = await promise;
    expect(result.status).toBe('succeeded');
    expect(result.provider).toBe('smtp');
    expect(mocks.spawn).toHaveBeenCalledWith(
      'python3',
      expect.arrayContaining(['-c', expect.stringContaining('import smtplib')]),
      expect.any(Object)
    );
  });
});
