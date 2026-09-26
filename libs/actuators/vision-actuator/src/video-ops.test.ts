import { describe, expect, it, vi } from 'vitest';
import { registerRiskyApprovalHandler } from '@agent/core/risky-op-approval-port';
import type { BuildVideoBriefOptions, VideoIngestOutcome } from '@agent/core/video-ingest';
import { handleBuildVideoBrief, handleFetchVideo } from './video-ops.js';

const pending: VideoIngestOutcome = {
  status: 'approval_required',
  code: 'APPROVAL_REQUIRED',
  message: 'needs approval',
};

describe('video ops approval context', () => {
  it('forwards only the agent id; correlation, channel and presence params are dropped', async () => {
    const build = vi.fn(async () => pending);
    await handleFetchVideo(
      {
        url: 'https://youtu.be/abc',
        approval: {
          agent_id: ' agent-a ',
          correlation_id: 'video-ingest:replayed',
          channel: 'slack',
          has_human: true,
          has_ui: true,
          non_interactive: false,
        } as unknown as { agent_id: string },
      },
      { build }
    );
    const options = (build.mock.calls[0] as unknown as [unknown, BuildVideoBriefOptions])[1];
    expect(options.approval).toEqual({ agent_id: 'agent-a' });
  });

  it('passes keep_source through and validates it', async () => {
    const build = vi.fn(async () => pending);
    await handleBuildVideoBrief({ path: 'a.mp4', keep_source: true }, { build });
    expect((build.mock.calls[0] as unknown as [unknown, BuildVideoBriefOptions])[1]).toEqual({
      keep_source: true,
    });
    await expect(
      handleBuildVideoBrief({ path: 'a.mp4', keep_source: 'yes' as unknown as boolean }, { build })
    ).rejects.toThrow('[VIDEO_INVALID_PARAMS]');
  });

  it('runs with the governed approval handler registered in the actuator process', () => {
    expect(() =>
      registerRiskyApprovalHandler(() => ({ allowed: true, status: 'approved' }))
    ).toThrow('RISKY_APPROVAL_HANDLER_ALREADY_REGISTERED');
  });
});
