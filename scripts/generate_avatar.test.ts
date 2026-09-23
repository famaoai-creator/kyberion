import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import type { ImageGenerationRequest } from '@agent/core/image-generation-types';

const mocks = vi.hoisted(() => ({ generateImage: vi.fn(), planImageGeneration: vi.fn() }));
vi.mock('@agent/core/image-generation-bridge', () => ({
  generateImage: mocks.generateImage,
  planImageGeneration: mocks.planImageGeneration,
}));

import {
  AVATAR_HANDOFF_MANIFEST,
  AVATAR_PLAN_PREFIX,
  AVATAR_SET_RESULT_PREFIX,
  DEFAULT_AVATAR_STYLE,
  main,
} from './generate_avatar.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);

describe('generate_avatar expression set', () => {
  const root = pathResolver.sharedTmp(`generate-avatar-test-${process.pid}`);
  const photo = path.join(root, 'face.jpg');
  const outDir = path.join(root, 'avatar');
  const rel = (value: string) => pathResolver.toRepoRelative(value);

  beforeEach(() => {
    vi.clearAllMocks();
    safeMkdir(root, { recursive: true });
    safeWriteFile(photo, JPEG);
    mocks.generateImage.mockImplementation(async (request: ImageGenerationRequest) => {
      safeWriteFile(request.targetPath!, PNG);
      return { status: 'succeeded', provider: 'stub_ref', path: request.targetPath, elapsedMs: 1 };
    });
  });

  afterEach(() => {
    safeRmSync(root, { recursive: true, force: true });
    safeRmSync(pathResolver.resolve(AVATAR_HANDOFF_MANIFEST), { force: true });
  });

  it('generates neutral from the photo, then every expression with photo + neutral', async () => {
    const print = vi.fn();
    const result = await main(
      ['--input-photo', rel(photo), '--output-dir', rel(outDir), '--style', 'watercolour'],
      print
    );
    const calls = mocks.generateImage.mock.calls.map(
      ([request]) => request as ImageGenerationRequest
    );
    expect(calls.map((request) => path.basename(request.targetPath!))).toEqual([
      'neutral.png',
      'joy.png',
      'thinking.png',
      'listening.png',
      'speaking.png',
      'mouth_open.png',
    ]);
    expect(calls[0]!.referenceImages).toEqual([
      { path: photo, mimeType: 'image/jpeg', role: 'subject' },
    ]);
    for (const request of calls.slice(1)) {
      expect(request.referenceImages).toEqual([
        { path: photo, mimeType: 'image/jpeg', role: 'subject' },
        { path: path.join(outDir, 'neutral.png'), mimeType: 'image/png', role: 'consistency' },
      ]);
      // The set stays on the provider that produced neutral.
      expect(request.providerPreference![0]).toBe('stub_ref');
    }
    expect(calls.every((request) => request.prompt.includes('Style: watercolour.'))).toBe(true);
    expect(calls[5]!.prompt).toContain('mouth is open');

    const profile = JSON.parse(
      String(safeReadFile(path.join(outDir, 'avatar-profile.json'), { encoding: 'utf8' }))
    );
    expect(profile).toMatchObject({
      version: 1,
      images: {
        neutral: 'neutral.png',
        joy: 'joy.png',
        thinking: 'thinking.png',
        listening: 'listening.png',
        speaking: 'speaking.png',
        mouth_open: 'mouth_open.png',
      },
      mouth: { x: 0.5, y: 0.68, width: 0.22 },
      provider_id: 'stub_ref',
      style: 'watercolour',
    });
    expect(result.status).toBe('succeeded');
    expect(print).toHaveBeenCalledWith(expect.stringContaining('Generating avatar based on:'));
    const line = print.mock.calls
      .map(([value]) => String(value))
      .find((value) => value.startsWith(AVATAR_SET_RESULT_PREFIX));
    expect(JSON.parse(line!.slice(AVATAR_SET_RESULT_PREFIX.length)).status).toBe('succeeded');
  });

  it('passes the CLI consent through to every request', async () => {
    await main(
      [
        '--input-photo',
        rel(photo),
        '--output-dir',
        rel(outDir),
        '--expressions',
        'neutral,joy',
        '--consent-provider',
        'gemini_image',
        '--consent-granted-by',
        'human:owner',
      ],
      () => undefined
    );
    expect(mocks.generateImage).toHaveBeenCalledTimes(2);
    for (const [request] of mocks.generateImage.mock.calls) {
      expect((request as ImageGenerationRequest).egressConsent).toMatchObject({
        subject: 'user_photo',
        provider_id: 'gemini_image',
        provider_class: 'cloud',
        granted_by: 'human:owner',
      });
    }
  });

  it('keeps the v1 flags: --prompt seeds the style, --output-path gets neutral', async () => {
    const legacy = path.join(root, 'legacy.png');
    await main(
      [
        '--input-photo',
        rel(photo),
        '--output-dir',
        rel(outDir),
        '--output-path',
        rel(legacy),
        '--prompt',
        'Pixar style',
        '--expressions',
        'neutral',
      ],
      () => undefined
    );
    expect((mocks.generateImage.mock.calls[0]![0] as ImageGenerationRequest).prompt).toContain(
      'Style: Pixar style.'
    );
    expect(safeExistsSync(legacy)).toBe(true);
  });

  it('uses the default style without flags', async () => {
    await main([
      '--input-photo',
      rel(photo),
      '--output-dir',
      rel(outDir),
      '--expressions',
      'neutral',
    ]);
    expect((mocks.generateImage.mock.calls[0]![0] as ImageGenerationRequest).prompt).toContain(
      DEFAULT_AVATAR_STYLE
    );
  });

  it('collects host hand-offs for the whole set and exits 100 with a manifest', async () => {
    mocks.generateImage.mockRejectedValue(
      new Error('HOST_AGENT_IMAGE_GENERATION_REQUIRED: Host agent bridge is required.')
    );
    const error = await main(['--input-photo', rel(photo), '--output-dir', rel(outDir)]).catch(
      (caught) => caught
    );
    expect(error.code).toBe(100);
    expect(error.message).toContain('HOST_AGENT_IMAGE_GENERATION_REQUIRED');
    expect(error.message).toContain('6 avatar frame(s)');
    expect(mocks.generateImage).toHaveBeenCalledTimes(6);
    const manifest = JSON.parse(
      String(safeReadFile(pathResolver.resolve(AVATAR_HANDOFF_MANIFEST), { encoding: 'utf8' }))
    );
    expect(manifest.frames.map((frame: { expression: string }) => frame.expression)).toEqual([
      'neutral',
      'joy',
      'thinking',
      'listening',
      'speaking',
      'mouth_open',
    ]);
    expect(safeExistsSync(path.join(outDir, 'avatar-profile.json'))).toBe(false);
  });

  it('fails (exit 1) on a consent refusal instead of writing a partial profile', async () => {
    mocks.generateImage.mockRejectedValue(
      new Error('[IMAGE_REFERENCE_EGRESS_DENIED] gemini_image would receive ...')
    );
    const error = await main(['--input-photo', rel(photo), '--output-dir', rel(outDir)]).catch(
      (caught) => caught
    );
    expect(error.code).toBe(1);
    expect(error.message).toContain('IMAGE_REFERENCE_EGRESS_DENIED');
    expect(safeExistsSync(path.join(outDir, 'avatar-profile.json'))).toBe(false);
  });

  it('removes a transient capture with --cleanup-input once the set exists', async () => {
    await main([
      '--input-photo',
      rel(photo),
      '--output-dir',
      rel(outDir),
      '--expressions',
      'neutral',
      '--cleanup-input',
    ]);
    expect(safeExistsSync(photo)).toBe(false);
  });

  it('--plan names the provider without generating anything', async () => {
    const plan = {
      provider_id: 'gemini_image',
      display_name: 'Google Gemini API',
      data_egress: 'cloud',
      requires_consent: true,
      interactive_handoff: false,
    };
    mocks.planImageGeneration.mockResolvedValue(plan);
    const print = vi.fn();
    const result = await main(
      ['--input-photo', rel(photo), '--output-dir', rel(outDir), '--plan'],
      print
    );
    expect(result.plan).toEqual(plan);
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.planImageGeneration.mock.calls[0]![0].referenceImages).toEqual([
      { path: photo, mimeType: 'image/jpeg', role: 'subject' },
    ]);
    expect(print).toHaveBeenCalledWith(`${AVATAR_PLAN_PREFIX}${JSON.stringify({ plan })}`);
  });

  it('rejects unknown expressions', async () => {
    await expect(
      main(['--input-photo', rel(photo), '--output-dir', rel(outDir), '--expressions', 'angry'])
    ).rejects.toThrow('Unknown expression(s): angry');
  });
});
