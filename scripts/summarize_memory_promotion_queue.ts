/**
 * summarize_memory_promotion_queue.ts — thin CLI shell (LE-03).
 *
 * The summary logic lives in @agent/core report-ops and is exposed in-process
 * as the `system:summarize_memory_promotion_queue` op. This shell remains for
 * direct CLI use (`--status <s> --output <path> --json`).
 */

import { pathResolver, safeWriteFile } from '@agent/core';
import { formatMemoryPromotionQueueMarkdown, summarizeMemoryPromotionQueue } from '@agent/core';

export { summarizeMemoryPromotionQueue };

function main() {
  const jsonOnly = process.argv.includes('--json');
  const statusArgIndex = process.argv.indexOf('--status');
  const outputArgIndex = process.argv.indexOf('--output');
  const status = statusArgIndex >= 0 ? process.argv[statusArgIndex + 1] : undefined;
  const outputPath = outputArgIndex >= 0 ? process.argv[outputArgIndex + 1] : undefined;
  const rows = summarizeMemoryPromotionQueue(status);

  if (outputPath) {
    const absPath = pathResolver.resolve(outputPath);
    safeWriteFile(
      absPath,
      jsonOnly
        ? `${JSON.stringify({ rows }, null, 2)}\n`
        : `${formatMemoryPromotionQueueMarkdown(rows)}\n`
    );
  }

  if (jsonOnly) {
    console.log(JSON.stringify({ rows }, null, 2));
    return;
  }
  console.log(formatMemoryPromotionQueueMarkdown(rows));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
