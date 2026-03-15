import { pathResolver, logger, safeExistsSync, safeMkdir, safeReadFile } from '@agent/core';
import * as path from 'node:path';
import { handleAction } from '../libs/actuators/media-actuator/src/index.js';

/**
 * Design Pattern Generator
 *
 * Generates documents from design patterns using the Media-Actuator pipeline.
 *
 * Usage:
 *   pnpm exec tsx scripts/generate_marketing_deck.ts                                  # default marketing deck
 *   pnpm exec tsx scripts/generate_marketing_deck.ts --pattern <pattern_path>         # custom pattern
 *   pnpm exec tsx scripts/generate_marketing_deck.ts --pattern <path> --theme <name>  # with theme
 *   pnpm exec tsx scripts/generate_marketing_deck.ts --pattern <path> --output <path> # custom output
 */

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag: string) => {
    const idx = args.indexOf(flag);
    return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const patternRelPath = getArg('--pattern')
    || 'knowledge/public/design-patterns/presentation/kyberion-marketing-deck.json';
  const themeName = getArg('--theme') || 'kyberion-standard';
  const outputArg = getArg('--output');

  // Resolve pattern path
  const patternPath = patternRelPath.startsWith('/')
    ? patternRelPath
    : path.join(process.cwd(), patternRelPath);

  if (!safeExistsSync(patternPath)) {
    logger.error(`Pattern file not found: ${patternPath}`);
    process.exit(1);
  }

  const pattern = JSON.parse(safeReadFile(patternPath, { encoding: 'utf8' }) as string);
  const engine = pattern.media_actuator_config?.engine || 'pptx';

  // Determine output path
  const ext = engine === 'pptx' ? '.pptx' : engine === 'd2' ? '.svg' : '.pdf';
  const defaultName = pattern.pattern_id?.replace(/[^a-zA-Z0-9_-]/g, '_') || 'output';
  const outputPath = outputArg || `scratch/${defaultName}${ext}`;

  const outputDir = path.dirname(path.resolve(process.cwd(), outputPath));
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }

  logger.info(`Generating from pattern: ${pattern.pattern_id} (${engine})`);
  logger.info(`Theme: ${themeName}`);
  logger.info(`Output: ${outputPath}`);

  // Build Media-Actuator pipeline
  const result = await handleAction({
    action: 'pipeline',
    steps: [
      {
        type: 'transform',
        op: 'apply_theme',
        params: { theme: themeName },
      },
      {
        type: 'transform',
        op: 'apply_pattern',
        params: { pattern_path: patternRelPath },
      },
      {
        type: 'transform',
        op: 'merge_content',
        params: { output_format: engine },
      },
      {
        type: 'apply',
        op: engine === 'pptx' ? 'pptx_render' : 'log',
        params: engine === 'pptx'
          ? { path: outputPath }
          : { message: `Generated ${engine} output for ${pattern.pattern_id}` },
      },
    ],
  });

  const failed = result.results.filter((r: any) => r.status === 'failed');
  if (failed.length > 0) {
    logger.error(`Generation failed: ${failed.map((f: any) => f.error).join(', ')}`);
    process.exit(1);
  }

  logger.info(`Generation complete: ${outputPath}`);
}

main().catch(err => {
  logger.error(err.message);
  process.exit(1);
});
