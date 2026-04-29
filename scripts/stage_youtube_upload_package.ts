import {
  buildNarratedVideoUploadPackage,
  pathResolver,
  safeReadFile,
  safeWriteFile,
} from '@agent/core';

function normalizeFileStem(input: string): string {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function main(): void {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath) {
    throw new Error('Usage: stage_youtube_upload_package <publish-plan-json> [output-json]');
  }
  const publishPlan = JSON.parse(
    safeReadFile(pathResolver.rootResolve(inputPath), { encoding: 'utf8' }) as string
  );
  const pkg = buildNarratedVideoUploadPackage(publishPlan, inputPath);
  const defaultStem = normalizeFileStem(pkg.title || 'youtube-upload');
  const resolvedOutput =
    outputPath || `active/shared/runtime/youtube/upload-packages/${defaultStem}.json`;
  safeWriteFile(pathResolver.rootResolve(resolvedOutput), JSON.stringify(pkg, null, 2));
  process.stdout.write(
    `${JSON.stringify({ status: 'succeeded', output: resolvedOutput }, null, 2)}\n`
  );
}

main();
