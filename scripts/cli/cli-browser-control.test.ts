import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runBrowserControlCommand } from './cli-browser-control.js';

// The service/recording modules are mocked at the boundary — these tests pin
// the CLI's argument parsing, approval-resume wiring, review gating and the
// promote wrapper's argument assembly.
const service = vi.hoisted(() => ({
  approvalStatus: vi.fn(),
  awaitStepResult: vi.fn(),
  completeStepApproval: vi.fn(),
  drainStepSecrets: vi.fn(() => null),
  endBrowserControlSession: vi.fn(),
  enqueueSessionStep: vi.fn(() => ({ status: 'queued', request_id: 'req-1' })),
  loadPendingStep: vi.fn(),
  mintSessionIfApproved: vi.fn(),
  requestBrowserControlSession: vi.fn(),
}));
vi.mock('@agent/shared-vision/browser-control-service', () => service);

const sessions = vi.hoisted(() => ({
  listBrowserControlSessions: vi.fn(() => []),
}));
vi.mock('@agent/shared-vision/browser-control-sessions', () => sessions);

const recording = vi.hoisted(() => ({
  exportBrowserControlRecording: vi.fn(),
  listExportedRecordings: vi.fn(() => []),
  loadExportedRecording: vi.fn(),
  reviewExportedRecording: vi.fn(),
}));
vi.mock('@agent/shared-vision/browser-control-recording', () => recording);

const execCalls = vi.hoisted(() => ({ args: [] as string[][] }));
vi.mock('@agent/core/secure-io', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/secure-io')>();
  return {
    ...actual,
    safeExec: vi.fn((_cmd: string, args: string[]) => {
      execCalls.args.push(args);
      return 'promoted ok';
    }),
  };
});

vi.mock('@agent/core/authority', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/authority')>();
  return {
    ...actual,
    withExecutionContext: vi.fn((_c: string, fn: () => unknown) => fn()),
    withExecutionContextAsync: vi.fn(async (_c: string, fn: () => Promise<unknown>) => fn()),
  };
});

vi.mock('./cli-browser-bridge.js', () => ({
  resolveBrowserBridgeActor: () => 'agent:test',
}));

function capture() {
  const lines: string[] = [];
  return { lines, print: (line: string) => lines.push(line) };
}

const mintedSession = {
  session_id: 'BCS-11111111-2222-3333-4444-555555555555',
  origin: 'https://example.com',
};

beforeEach(() => {
  vi.clearAllMocks();
  execCalls.args.length = 0;
  service.drainStepSecrets.mockReturnValue(null);
  service.enqueueSessionStep.mockReturnValue({ status: 'queued', request_id: 'req-1' });
  service.awaitStepResult.mockResolvedValue({
    status: 'completed',
    response: { result: { ok: true } },
  });
});

describe('browser control open --approval resume', () => {
  it('mints from an existing approval instead of creating a new request', async () => {
    service.approvalStatus.mockReturnValue({
      status: 'approved',
      record: {
        justification: { requestedEffects: ['browser-control:https://example.com'] },
      },
    });
    service.mintSessionIfApproved.mockReturnValue({
      status: 'minted',
      session: mintedSession,
    });

    const out = capture();
    await runBrowserControlCommand(
      ['open', 'https://example.com/inbox', '--approval', 'APR-1'],
      out.print
    );

    expect(service.requestBrowserControlSession).not.toHaveBeenCalled();
    expect(service.mintSessionIfApproved).toHaveBeenCalledWith(
      'APR-1',
      expect.objectContaining({ origin: 'https://example.com' })
    );
    expect(service.enqueueSessionStep).toHaveBeenCalledWith(
      expect.objectContaining({
        step: expect.objectContaining({ op: 'open_tab', url: 'https://example.com/inbox' }),
      })
    );
  });

  it('defaults the opened tab to the approved origin when no url is given', async () => {
    service.approvalStatus.mockReturnValue({
      status: 'approved',
      record: {
        justification: { requestedEffects: ['browser-control:https://example.com'] },
      },
    });
    service.mintSessionIfApproved.mockReturnValue({
      status: 'minted',
      session: mintedSession,
    });

    await runBrowserControlCommand(['open', '--approval', 'APR-1'], capture().print);
    expect(service.enqueueSessionStep).toHaveBeenCalledWith(
      expect.objectContaining({
        step: expect.objectContaining({ op: 'open_tab', url: 'https://example.com' }),
      })
    );
  });

  it('refuses a url whose origin the approval was not granted for', async () => {
    service.approvalStatus.mockReturnValue({
      status: 'approved',
      record: {
        justification: { requestedEffects: ['browser-control:https://example.com'] },
      },
    });
    await expect(
      runBrowserControlCommand(
        ['open', 'https://evil.example.net/', '--approval', 'APR-1'],
        () => {}
      )
    ).rejects.toThrow(/url origin does not match approval/);
    expect(service.mintSessionIfApproved).not.toHaveBeenCalled();
  });

  it('refuses a non-browser-control approval id', async () => {
    service.approvalStatus.mockReturnValue({
      status: 'approved',
      record: { justification: { requestedEffects: ['something-else:x'] } },
    });
    await expect(
      runBrowserControlCommand(['open', '--approval', 'APR-9'], () => {})
    ).rejects.toThrow(/not a browser-control session request/);
  });

  it('requests a fresh approval on the normal open path', async () => {
    service.requestBrowserControlSession.mockReturnValue({
      approval_request_id: 'APR-new',
      origin: 'https://example.com',
    });
    const out = capture();
    await runBrowserControlCommand(
      ['open', 'https://example.com', '--no-wait', '--json'],
      out.print
    );
    const printed = JSON.parse(out.lines.join('\n')) as Record<string, string>;
    expect(printed.status).toBe('approval_pending');
    expect(printed.then).toContain('--approval APR-new');
    expect(service.mintSessionIfApproved).not.toHaveBeenCalled();
  });
});

describe('browser control option validation', () => {
  it.each([
    [['open', 'https://example.com', '--ceiling', 'bogus'], /--ceiling must be low\|observe/],
    [
      ['snapshot', '--session', 'BCS-x', '--timeout-sec', 'abc'],
      /--timeout-sec must be a positive number/,
    ],
    [
      ['snapshot', '--session', 'BCS-x', '--timeout-sec', '0'],
      /--timeout-sec must be a positive number/,
    ],
  ])('rejects %j', async (args, pattern) => {
    await expect(runBrowserControlCommand(args, () => {})).rejects.toThrow(pattern);
  });
});

describe('browser control promote', () => {
  const approvedRecording = {
    recording_id: 'BCR-1',
    schema_version: 'browser-recording.v1',
    tab: { origin: 'https://slack.example.com', title: 'Slack admin flow' },
    review: { status: 'approved' },
  };

  it('refuses to promote a recording whose review is not approved', async () => {
    recording.loadExportedRecording.mockReturnValue({
      ...approvedRecording,
      review: { status: 'pending' },
    });
    await expect(
      runBrowserControlCommand(['promote', '--recording', 'BCR-1'], () => {})
    ).rejects.toThrow(/review is "pending"/);
    expect(execCalls.args).toHaveLength(0);
  });

  it('assembles promote-procedure arguments from recording metadata', async () => {
    recording.loadExportedRecording.mockReturnValue(approvedRecording);
    const out = capture();
    await runBrowserControlCommand(
      ['promote', '--recording', 'BCR-1', '--intent', 'open settings, create app'],
      out.print
    );
    expect(execCalls.args).toHaveLength(1);
    const args = execCalls.args[0];
    expect(args).toContain('scripts/promote/promote_procedure.ts');
    expect(args).toContain('--recording');
    expect(args).toContain('--procedure-id');
    expect(args).toContain('slack-example-com');
    expect(args).toContain(JSON.stringify(['open settings', 'create app']));
    expect(out.lines.join('\n')).toContain('promoted');
  });

  it('forwards an explicit --id and --mission', async () => {
    recording.loadExportedRecording.mockReturnValue(approvedRecording);
    await runBrowserControlCommand(
      ['promote', '--recording', 'BCR-1', '--id', 'my-proc', '--mission', 'MSN-X'],
      () => {}
    );
    const args = execCalls.args[0];
    expect(args).toContain('my-proc');
    expect(args).toContain('--mission-id');
    expect(args).toContain('MSN-X');
  });
});
