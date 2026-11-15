import { afterAll, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeRmSync } from '@agent/core/secure-io';
import { stageYoutubeUploadPackage } from './stage_youtube_upload_package.js';

const OUT_DIR = 'active/shared/tmp/stage-youtube-upload-package-test';
const EXAMPLE_PLAN = 'knowledge/product/schemas/narrated-video-publish-plan.example.json';

describe('stage_youtube_upload_package (youtube preset prepare_upload_package)', () => {
  afterAll(() => {
    safeRmSync(pathResolver.rootResolve(OUT_DIR), { recursive: true, force: true });
  });

  it('builds the upload package from a validated publish plan and writes it', () => {
    const output = `${OUT_DIR}/package.json`;
    const staged = stageYoutubeUploadPackage(EXAMPLE_PLAN, output);

    expect(staged).toMatchObject({ status: 'succeeded', output });
    expect(staged.package).toMatchObject({
      kind: 'narrated-video-upload-package',
      publish_plan_ref: EXAMPLE_PLAN,
      visibility: 'unlisted',
      approval_boundary: 'before_public_release',
    });
    const written = JSON.parse(
      String(safeReadFile(pathResolver.rootResolve(output), { encoding: 'utf8' }))
    );
    expect(written).toEqual(staged.package);
  });

  it('rejects a document that is not a publish plan', () => {
    expect(() =>
      stageYoutubeUploadPackage(
        'knowledge/product/schemas/narrated-video-upload-package.example.json',
        `${OUT_DIR}/never.json`
      )
    ).toThrow();
  });
});
