import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import { parseSafeJsonObjectInput } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeReadFile, safeRealpath } from '@agent/core/secure-io';
import { parseVideoRecutRequest, prepareVideoRecut, renderVideoRecut } from '@agent/core/video';
import { defineScript, isDirectScript } from './lib/harness.js';

/** Prepare existing footage and supplied VTT; rendering is an explicit opt-in. */
export async function runVideoRecutCommand(
  args: string[],
  print: (value: unknown) => void
): Promise<void> {
  const argv = createStandardYargs([
    'node',
    'video_recut',
    ...args.filter((arg) => arg !== '--json'),
  ])
    .option('input', { type: 'string', demandOption: true })
    .option('render', { type: 'boolean', default: false })
    .check((parsed) => {
      if (parsed['dry-run'] || parsed.out || parsed.tier !== 'public') {
        throw new Error('Recut supports public scratch input only; use bundle_dir in the request');
      }
      return true;
    })
    .strict()
    .parseSync();
  const inputPath = safeRealpath(assertSafeRepositoryPath(pathResolver.resolve(argv.input)));
  const relative = path.relative(safeRealpath(pathResolver.sharedTmp()), inputPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Recut input must be a local file under active/shared/tmp/');
  }
  const request = parseVideoRecutRequest(
    parseSafeJsonObjectInput(
      String(safeReadFile(inputPath, { encoding: 'utf8' })),
      'video recut input'
    )
  );
  const prepared = await prepareVideoRecut(request);
  const rendered = argv.render ? await renderVideoRecut(prepared) : undefined;
  print({
    status: rendered ? 'rendered' : 'prepared',
    bundle_dir: prepared.bundle_dir,
    index_html: prepared.index_html,
    source_map_path: prepared.source_map_path,
    duration_sec: prepared.duration_sec,
    ...(rendered ? { output_path: rendered.output_path } : {}),
  });
}
const script = defineScript({
  name: 'video:recut',
  flags: ['json'],
  run: ({ argv, print }) => runVideoRecutCommand(argv, print),
});
if (
  isDirectScript(import.meta.url, 'video_recut.ts') ||
  isDirectScript(import.meta.url, 'video_recut.js')
)
  void script();
