/**
 * Stage a narrated-video upload package from a publish plan. This is the
 * command behind the `youtube` service preset `prepare_upload_package`
 * (knowledge/product/orchestration/service-presets/youtube.json).
 *
 * It only writes the package JSON (checklist + artifact refs); it never
 * uploads. Public release stays behind the plan's approval boundary in the
 * browser-driven or manual upload step.
 *
 *   node dist/scripts/stage_youtube_upload_package.js <publish-plan.json> [output.json]
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { defineCatalog, slugify } from '@agent/core/foundation';
import { buildNarratedVideoUploadPackage } from '@agent/core/video/narrated-video-upload-package';
import type { NarratedVideoPublishPlan } from '@agent/core/contracts/narrated-video-publish-plan';
import type { NarratedVideoUploadPackage } from '@agent/core/contracts/narrated-video-upload-package';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const PUBLISH_PLAN_SCHEMA = 'product/schemas/narrated-video-publish-plan.schema.json';
const DEFAULT_OUTPUT_DIR = 'active/shared/runtime/youtube/upload-packages';

export interface StagedUploadPackage {
  status: 'succeeded';
  output: string;
  package: NarratedVideoUploadPackage;
}

/** Validate the publish plan, build the package and write it under the repository. */
export function stageYoutubeUploadPackage(
  publishPlanPath: string,
  outputPath?: string
): StagedUploadPackage {
  const publishPlan = defineCatalog<NarratedVideoPublishPlan>({
    id: 'narrated-video-publish-plan',
    path: pathResolver.rootResolve(publishPlanPath),
    schema: pathResolver.knowledge(PUBLISH_PLAN_SCHEMA),
  }).load();
  const uploadPackage = buildNarratedVideoUploadPackage(publishPlan, publishPlanPath);
  const output =
    outputPath ||
    `${DEFAULT_OUTPUT_DIR}/${slugify(uploadPackage.title, { fallback: 'youtube-upload' })}.json`;
  const absoluteOutput = pathResolver.rootResolve(output);
  safeMkdir(path.dirname(absoluteOutput), { recursive: true });
  safeWriteFile(absoluteOutput, `${JSON.stringify(uploadPackage, null, 2)}\n`);
  return { status: 'succeeded', output, package: uploadPackage };
}

export const runStageYoutubeUploadPackage = defineScript({
  name: 'stage-youtube-upload-package',
  flags: [],
  run(context) {
    const [publishPlanPath, outputPath] = context.argv.filter((arg) => !arg.startsWith('--'));
    if (!publishPlanPath) {
      throw new ScriptExitError(
        1,
        'Usage: stage_youtube_upload_package <publish-plan.json> [output.json]'
      );
    }
    const staged = stageYoutubeUploadPackage(publishPlanPath, outputPath);
    context.print({ status: staged.status, output: staged.output });
    return staged;
  },
});

if (
  isDirectScript(import.meta.url, 'stage_youtube_upload_package.ts') ||
  isDirectScript(import.meta.url, 'stage_youtube_upload_package.js')
)
  void runStageYoutubeUploadPackage();
