import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';

const requireRiskyApproval = vi.fn();
vi.mock('../risky-op-approval-port.js', () => ({
  requireRiskyApproval: (...args: unknown[]) => requireRiskyApproval(...args),
}));
vi.mock('../agent/agent-manifest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../agent/agent-manifest.js')>()),
  getAgentManifest: () => null,
}));

const { resolveAcpPermissionRequest } = await import('./acp-mediator.js');

const request = (title: string) =>
  ({
    sessionId: 's-1',
    toolCall: { toolCallId: 'call-1', title },
    options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }],
  }) as RequestPermissionRequest;

describe('resolveAcpPermissionRequest', () => {
  beforeEach(() => {
    requireRiskyApproval.mockReset();
  });

  it('passes the mediator hasHuman/hasUI/nonInteractive options to the risky approval', async () => {
    requireRiskyApproval.mockReturnValue({ allowed: true });
    const result = await resolveAcpPermissionRequest(request('deploy production'), {
      threadId: 'perm-test',
      hasHuman: false,
      hasUI: true,
      nonInteractive: true,
    });
    expect(requireRiskyApproval).toHaveBeenCalledTimes(1);
    expect(requireRiskyApproval.mock.calls[0][0]).toMatchObject({
      opId: 'acp:tool',
      hasHuman: false,
      hasUI: true,
      nonInteractive: true,
    });
    expect(result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });

  it('cancels (fail-closed) when the approval is pending', async () => {
    requireRiskyApproval.mockReturnValue({ allowed: false });
    const result = await resolveAcpPermissionRequest(request('deploy production'), {
      threadId: 'perm-test',
    });
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(requireRiskyApproval.mock.calls[0][0]).not.toHaveProperty('hasHuman');
  });
});
