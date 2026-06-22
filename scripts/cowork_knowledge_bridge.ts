/**
 * Cowork Knowledge Bridge CLI (Phase 3)
 *
 * Usage:
 *   pnpm knowledge:cowork-sync
 *   pnpm knowledge:cowork-sync -- --direction kyberion-to-cowork
 *   pnpm knowledge:cowork-sync -- --direction cowork-to-kyberion --paths path1.md path2.md
 *   pnpm knowledge:cowork-sync -- --max-hints 20
 */

import { runCoworkKnowledgeSync } from '@agent/core/cowork-knowledge-bridge.js';

function parseArgs(argv: string[]): {
  direction: 'cowork-to-kyberion' | 'kyberion-to-cowork' | 'both';
  paths: string[];
  maxHints: number;
} {
  const args = argv.slice(2);
  let direction: 'cowork-to-kyberion' | 'kyberion-to-cowork' | 'both' = 'both';
  const paths: string[] = [];
  let maxHints = 50;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--direction' && args[i + 1]) {
      const d = args[++i];
      if (d === 'cowork-to-kyberion' || d === 'kyberion-to-cowork' || d === 'both') {
        direction = d;
      }
    } else if (args[i] === '--paths') {
      while (args[i + 1] && !args[i + 1].startsWith('--')) {
        paths.push(args[++i]);
      }
    } else if (args[i] === '--max-hints' && args[i + 1]) {
      maxHints = parseInt(args[++i], 10) || 50;
    }
  }

  return { direction, paths, maxHints };
}

const { direction, paths, maxHints } = parseArgs(process.argv);

const result = runCoworkKnowledgeSync({
  direction,
  coworkArtifactPaths: paths,
  maxHints,
});

process.stdout.write(JSON.stringify(result, null, 2) + '\n');

if (result.ingest) {
  process.stderr.write(`[cowork-sync] Ingest: ${result.ingest.enqueued} enqueued, ${result.ingest.skipped_duplicate} skipped (dup), ${result.ingest.skipped_tier_violation} skipped (tier)\n`);
}
if (result.supply) {
  process.stderr.write(`[cowork-sync] Supply: ${result.supply.delivered} hints delivered, ${result.supply.skipped_unchanged} unchanged\n`);
}
if (result.ingest?.errors.length || result.supply?.errors.length) {
  const errs = [...(result.ingest?.errors ?? []), ...(result.supply?.errors ?? [])];
  process.stderr.write(`[cowork-sync] Errors:\n${errs.map((e) => `  - ${e}`).join('\n')}\n`);
}
