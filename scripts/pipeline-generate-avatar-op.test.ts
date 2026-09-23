import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';

const mocks = vi.hoisted(() => ({
  runGenerateAvatar: vi.fn(),
  runRegisterAvatar: vi.fn(),
  runCapturePhoto: vi.fn(),
  profileRoot: '',
}));
vi.mock('./generate_avatar.js', () => ({ runGenerateAvatar: mocks.runGenerateAvatar }));
vi.mock('./register_avatar.js', () => ({ runRegisterAvatar: mocks.runRegisterAvatar }));
vi.mock('./capture_photo.js', () => ({ runCapturePhoto: mocks.runCapturePhoto }));
vi.mock('@agent/core/profile-root', () => ({
  resolveActiveProfileRoot: () => mocks.profileRoot,
}));

import {
  defaultAvatarCapturePath,
  runInlineCaptureAvatarPhoto,
  runInlineGenerateAvatar,
  runInlineRegisterAvatar,
} from './pipeline-domain-ops.js';

const step = { produces: { channel: 'generation_result' } } as never;

describe('core:generate_avatar (PA-10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.profileRoot = pathResolver.sharedTmp(`avatar-op-profile-${process.pid}`);
  });
  afterEach(() => {
    safeRmSync(mocks.profileRoot, { recursive: true, force: true });
    process.exitCode = undefined;
  });

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
  it('restores process.exitCode after a nested hand-off / failure and still throws (m7)', async () => {
    process.exitCode = undefined;
    mocks.runGenerateAvatar.mockImplementation(async () => {
      process.exitCode = 100;
      return { status: 'handoff', message: 'HOST_AGENT_IMAGE_GENERATION_REQUIRED: ...' };
    });
    await expect(runInlineGenerateAvatar(step, { input_photo: 'a.jpg' }, {})).rejects.toThrow(
      'did not complete (handoff)'
    );
    expect(process.exitCode).toBeUndefined();

    mocks.runGenerateAvatar.mockImplementation(async () => {
      process.exitCode = 1;
      return undefined;
    });
    await expect(runInlineGenerateAvatar(step, { input_photo: 'a.jpg' }, {})).rejects.toThrow(
      'did not complete (failed)'
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('defaults to the registered photo and the generator draft dir when paths are empty (m2)', async () => {
    mocks.runGenerateAvatar.mockResolvedValue({
      status: 'succeeded',
      output_dir: 'x/avatar/draft',
      images: {},
      handoffs: [],
    });
    await runInlineGenerateAvatar(
      step,
      { input_photo: '', output_dir: '{{avatar_output_dir}}', bridge_preference: 'host' },
      {}
    );
    const args = mocks.runGenerateAvatar.mock.calls[0]![0] as string[];
    expect(args).not.toContain('--input-photo');
    expect(args).not.toContain('--output-dir');
    expect(args).not.toContain('--output-path');
  });

  it('registers the capture as the reference photo in the profile root and deletes it (m2/m3)', async () => {
    const capture = defaultAvatarCapturePath(mocks.profileRoot);
    expect(capture).toBe(path.join(mocks.profileRoot, 'tmp', 'avatar-capture.jpg'));
    safeMkdir(path.dirname(capture), { recursive: true });
    safeWriteFile(capture, 'jpeg');
    mocks.runRegisterAvatar.mockResolvedValue(undefined);
    await runInlineRegisterAvatar(
      step,
      { src_avatar: '', dest_avatar: '', identity_path: '', cleanup_source: 'true' },
      {}
    );
    const args = mocks.runRegisterAvatar.mock.calls[0]![0] as string[];
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag('--src-avatar')).toBe(capture);
    expect(flag('--dest-avatar')).toBe(path.join(mocks.profileRoot, 'avatar.png'));
    expect(flag('--identity-path')).toBe(path.join(mocks.profileRoot, 'my-identity.json'));
    expect(flag('--avatar-path')).toBe('avatar.png');
    expect(safeExistsSync(capture)).toBe(false);

    // A failed registration still removes the capture and surfaces the failure.
    safeWriteFile(capture, 'jpeg');
    mocks.runRegisterAvatar.mockImplementation(async () => {
      process.exitCode = 1;
      return undefined;
    });
    await expect(
      runInlineRegisterAvatar(step, { src_avatar: '', cleanup_source: 'true' }, {})
    ).rejects.toThrow('core:register_avatar failed');
    expect(safeExistsSync(capture)).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('captures into the profile-root tmp and removes a partial capture on failure (m3)', async () => {
    mocks.runCapturePhoto.mockImplementation(async ([output]: string[]) => {
      safeWriteFile(output!, 'partial');
      process.exitCode = 1;
      return undefined;
    });
    await expect(runInlineCaptureAvatarPhoto(step, { output_path: '' }, {})).rejects.toThrow(
      'core:capture_avatar_photo failed'
    );
    const capture = defaultAvatarCapturePath(mocks.profileRoot);
    expect(mocks.runCapturePhoto.mock.calls[0]![0]).toEqual([capture]);
    expect(safeExistsSync(capture)).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });
});
