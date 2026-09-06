/**
 * summarize_memory_promotion_queue.ts — thin CLI shell (LE-03).
 *
 * The summary logic lives in @agent/core report-ops and is exposed in-process
 * as the `system:summarize_memory_promotion_queue` op. This shell remains for
 * direct CLI use (`--status <s> --output <path> --json`).
 */

import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeWriteFile } from '@agent/core/secure-io';
import {
  formatMemoryPromotionQueueMarkdown,
  summarizeMemoryPromotionQueue,
} from '@agent/core/report-ops';
import { defineScript, isDirectScript } from './lib/harness.js';

export { summarizeMemoryPromotionQueue };

export const MEMORY_PROMOTION_QUEUE_USAGE =
  'Usage: pnpm memory:summarize-promotion-queue [--status <status>] [--output <path>] [--json]';

export function main(argv: string[] = []): {
  rows?: ReturnType<typeof summarizeMemoryPromotionQueue>;
  output?: string;
  help?: string;
} {
  if (argv.includes('--help') || argv.includes('-h')) return { help: MEMORY_PROMOTION_QUEUE_USAGE };

  const jsonOnly = argv.includes('--json');
  const statusArgIndex = argv.indexOf('--status');
  const outputArgIndex = argv.indexOf('--output');
  const status = statusArgIndex >= 0 ? argv[statusArgIndex + 1] : undefined;
  const outputPath = outputArgIndex >= 0 ? argv[outputArgIndex + 1] : undefined;
  const rows = summarizeMemoryPromotionQueue(status);

  if (outputPath) {
    const absPath = assertSafeRepositoryPath(pathResolver.resolve(outputPath), {
      allowMissingLeaf: true,
    });
    safeWriteFile(
      absPath,
      jsonOnly
        ? `${JSON.stringify({ rows }, null, 2)}\n`
        : `${formatMemoryPromotionQueueMarkdown(rows)}\n`
    );
  }

  if (jsonOnly) {
    return { rows, output: outputPath || JSON.stringify({ rows }, null, 2) };
  }
  return { rows, output: formatMemoryPromotionQueueMarkdown(rows) };
}

export const runSummarizeMemoryPromotionQueue = defineScript({
  name: 'memory:summarize-promotion-queue',
  flags: ['json'],
  run: ({ argv, json, print }) => {
    const result = main(argv);
    if (result.help) print(json ? result : result.help);
    else if (result.output !== undefined) print(result.output);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'summarize_memory_promotion_queue.ts') ||
  isDirectScript(import.meta.url, 'summarize_memory_promotion_queue.js')
)
  void runSummarizeMemoryPromotionQueue();
