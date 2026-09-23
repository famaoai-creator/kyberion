import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ runGenerateAvatar: vi.fn() }));
vi.mock('./generate_avatar.js', () => ({ runGenerateAvatar: mocks.runGenerateAvatar }));

import { runInlineGenerateAvatar } from './pipeline-domain-ops.js';

const step = { produces: { channel: 'generation_result' } } as never;

describe('core:generate_avatar (PA-10)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the set output dir, style and per-run consent to the generator', async () => {
    mocks.runGenerateAvatar.mockResolvedValue({
      status: 'succeeded',
      output_dir: 'knowledge/personal/avatar',
      profile_path: 'knowledge/personal/avatar/avatar-profile.json',
      provider_id: 'host_agent',
      images: {},
      handoffs: [],
    });
    const ctx = await runInlineGenerateAvatar(
      step,
      {
        input_photo: 'active/shared/tmp/avatar-onboarding/user_face.jpg',
        output_dir: 'knowledge/personal/avatar',
        style: 'friendly',
        bridge_preference: 'host',
        consent_provider: 'host_agent',
        consent_granted_by: 'human:owner',
        cleanup_input: 'true',
      },
      {}
    );
    expect(mocks.runGenerateAvatar.mock.calls[0]![0]).toEqual([
      '--input-photo',
      'active/shared/tmp/avatar-onboarding/user_face.jpg',
      '--output-dir',
      'knowledge/personal/avatar',
      '--style',
      'friendly',
      '--bridge-preference',
      'host',
      '--consent-provider',
      'host_agent',
      '--consent-granted-by',
      'human:owner',
      '--cleanup-input',
    ]);
    expect(ctx.generation_result).toMatchObject({ status: 'succeeded', provider_id: 'host_agent' });
  });

  it('omits empty consent (no consent = local providers only) and stops on a hand-off', async () => {
    mocks.runGenerateAvatar.mockResolvedValue({
      status: 'handoff',
      message: 'HOST_AGENT_IMAGE_GENERATION_REQUIRED: ...',
    });
    await expect(
      runInlineGenerateAvatar(
        step,
        { input_photo: 'a.jpg', consent_provider: '', consent_granted_by: '{{who}}' },
        {}
      )
    ).rejects.toThrow('did not complete (handoff)');
    const args = mocks.runGenerateAvatar.mock.calls[0]![0] as string[];
    expect(args).not.toContain('--consent-provider');
    expect(args).not.toContain('--consent-granted-by');
  });
});
