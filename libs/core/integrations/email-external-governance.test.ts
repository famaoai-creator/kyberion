import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
vi.mock('../governance/approval-gate.js', () => ({ enforceApprovalGate: vi.fn() }));
vi.mock('../governance/audit-chain.js', () => ({ auditChain: { record: vi.fn() } }));
vi.mock('../governance/external-operation-store.js', () => ({ reserveExternalOperation: vi.fn() }));
vi.mock('../governance/accountability-charter-registry.js', () => ({
  findActiveCharter: vi.fn(() => null),
  loadCharterUsage: vi.fn(),
  recordCharterExecutionOutcome: vi.fn(),
  recordCharterExecutionStarted: vi.fn(),
}));
vi.mock('../scope-context.js', () => ({
  resolveScopeContext: vi.fn(() => ({ tenant_slug: 'email-tenant', tier: 'confidential' })),
}));
vi.mock('../scope-envelope.js', () => ({ currentScopeEnvelope: vi.fn(() => undefined) }));
vi.mock('../actuator/adapter-default-preferences.js', () => ({
  getAdapterDefault: vi.fn(() => 'smtp'),
}));
vi.mock('../pipeline/op-preflight.js', async (original) => ({
  ...(await original<typeof import('../pipeline/op-preflight.js')>()),
  runOpPreflight: vi.fn(async ({ params }) => ({ decision: 'allow', input: params })),
}));
vi.mock('../pipeline/op-preflight-defaults.js', () => ({ ensureDefaultOpPreflight: vi.fn() }));

import { enforceApprovalGate } from '../governance/approval-gate.js';
import { auditChain } from '../governance/audit-chain.js';
import { reserveExternalOperation } from '../governance/external-operation-store.js';
import { runOpPreflight } from '../pipeline/op-preflight.js';
import {
  withExternalOperationAuthority,
  withExternalOperationApprovalObserver,
  withExternalOperationPipelineRun,
} from '../governance/external-operation.js';
import {
  MacMailAppEmailProvider,
  SmtpEmailProvider,
  sendEmail,
  registerEmailBackend,
  createDraft,
} from './email-bridge.js';
import { actuator, handleAction } from '../../actuators/email-actuator/src/index.js';

const message = { to: 'recipient@example.com', subject: 'Subject', body: 'private message' };
const authority = {
  agentId: 'email-worker',
  tenantSlug: 'email-tenant',
  invocationId: 'send-invocation',
  hasHuman: false,
};

describe('email external governance at provider boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('KYBERION_SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('KYBERION_SMTP_USER', 'sender@example.com');
    vi.stubEnv('KYBERION_SMTP_PASS', 'password-secret');
    vi.stubEnv('KYBERION_EMAIL_FROM', 'configured@example.com');
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: false,
      status: 'pending',
      requestStatus: 'human_required',
    });
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stdout.emit('data', 'ok');
        child.emit('close', 0);
      });
      return child as never;
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['send', 'create_draft'] as const)(
    'blocks direct Mail.app %s before child launch',
    async (op) => {
      const provider = new MacMailAppEmailProvider();
      const execute =
        op === 'send' ? provider.send.bind(provider) : provider.createDraft.bind(provider);
      await expect(
        execute({ ...message, externalAuthority: authority, hasHuman: true, charter: {} } as never)
      ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
      expect(spawn).not.toHaveBeenCalled();
      expect(reserveExternalOperation).not.toHaveBeenCalled();
    }
  );

  it('blocks SMTP provider and public bridge send despite forged params', async () => {
    await expect(
      new SmtpEmailProvider().send({ ...message, approval: { allowed: true } } as never)
    ).rejects.toThrow('EXTERNAL_APPROVAL_REQUIRED');
    await expect(sendEmail({ ...message, backend: 'smtp' })).rejects.toThrow(
      'EXTERNAL_APPROVAL_REQUIRED'
    );
    expect(spawn).not.toHaveBeenCalled();
    expect(enforceApprovalGate).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'external-actuator', hasHuman: false })
    );
  });

  it('resolves backend readiness before requesting approval for unsupported drafts', async () => {
    await expect(createDraft({ ...message, backend: 'smtp' })).rejects.toThrow(
      'does not support draft'
    );
    expect(enforceApprovalGate).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('gates registered custom provider methods without a lower registry bypass', async () => {
    const send = vi.fn(async () => ({ status: 'succeeded' as const, provider: 'governed-custom' }));
    const registry = registerEmailBackend({
      id: 'governed-custom',
      isAvailable: () => true,
      send,
      createDraft: vi.fn(),
    });
    await expect(sendEmail({ ...message, backend: 'governed-custom' })).rejects.toThrow(
      'EXTERNAL_APPROVAL_REQUIRED'
    );
    await expect(registry.get('governed-custom').send(message)).rejects.toThrow(
      'EXTERNAL_APPROVAL_REQUIRED'
    );
    expect(send).not.toHaveBeenCalled();
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    await withExternalOperationAuthority(
      () => authority,
      () => sendEmail({ ...message, backend: 'governed-custom' })
    );
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('records SMTP recipient refusal as unknown and never retries the partial send', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stdout.emit('data', 'partial');
        child.emit('close', 0);
      });
      return child as never;
    });
    const result = await withExternalOperationAuthority(
      () => authority,
      () => sendEmail({ ...message, cc: 'cc@example.com' })
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('only some recipients'),
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    const script = vi.mocked(spawn).mock.calls[0]![1] as string[];
    expect(script.join(' ')).toContain('refused = server.sendmail');
    expect(script.join(' ')).toContain('"partial" if refused else "ok"');
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'unknown' }) })
    );
  });

  it('uses configured backend/account defaults and executes one admitted send', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    const resolver = vi.fn(() => authority);
    const result = await withExternalOperationAuthority(resolver, () => sendEmail(message));
    expect(result.status).toBe('succeeded');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: 'email:send',
        tenantSlug: 'email-tenant',
        effect: {
          backend: 'smtp',
          account: { host: 'smtp.example.com', port: 587, user: 'sender@example.com' },
          params: { ...message, from: 'configured@example.com', cc: '' },
        },
      })
    );
    expect(JSON.stringify(resolver.mock.calls)).not.toContain('password-secret');
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'succeeded' }) })
    );
  });

  it('records ambiguous transport failure without retrying or fabricating actuator success', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({ allowed: true, status: 'approved' });
    vi.mocked(spawn).mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), {
        stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(),
      });
      queueMicrotask(() => {
        child.stderr.emit('data', 'connection lost after send');
        child.emit('close', 1);
      });
      return child as never;
    });
    await expect(
      withExternalOperationAuthority(
        () => authority,
        () => handleAction({ action: 'send', params: message })
      )
    ).rejects.toThrow('connection lost');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(auditChain.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ outcome: 'unknown' }) })
    );
  });

  it('preserves pending approval observation through a failed SDK envelope', async () => {
    vi.mocked(enforceApprovalGate).mockReturnValue({
      allowed: false,
      status: 'pending',
      requestId: 'email-approval',
      requestStatus: 'created',
    });
    const observer = vi.fn();
    const result = await withExternalOperationApprovalObserver(observer, () =>
      actuator.dispatch('send', message)
    );
    expect(result.status).toBe('failed');
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        approval: expect.objectContaining({ requestId: 'email-approval' }),
      })
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rejects uncheckpointed multi-email envelopes before any effect', async () => {
    await expect(
      withExternalOperationPipelineRun('run', () =>
        handleAction({
          action: 'pipeline',
          steps: [
            { op: 'send', params: message },
            { op: 'send', params: message },
          ],
        })
      )
    ).rejects.toThrow('EXTERNAL_BATCH_CHECKPOINT_REQUIRED');
    expect(spawn).not.toHaveBeenCalled();
    expect(enforceApprovalGate).not.toHaveBeenCalled();
  });

  it('keeps preflight denial before admission and execution', async () => {
    vi.mocked(runOpPreflight).mockResolvedValueOnce({
      decision: 'deny',
      reason: 'policy denied',
      input: {},
    } as never);
    await expect(handleAction({ action: 'send', params: message })).rejects.toThrow(
      'OP_PREFLIGHT_DENY'
    );
    expect(enforceApprovalGate).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
});
